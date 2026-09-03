interface Env {
  DB: D1Database;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

type ArtifactKind = "database_dump" | "filestore_archive" | "manifest";

type StoredArtifact = {
  artifact_kind: ArtifactKind;
  size_bytes: number;
  sha256: string;
};

type UploadSource = {
  backup_job_id: string;
  tenant_id: string;
  provisioning_job_id: string;
  template_id: string;
  node_id: string;
  database_name: string;
  environment_kind: string;
  backup_type: string;
  state: string;
  manifest_sha256: string;
  total_size_bytes: number;
};

type UploadLeaseRow = {
  backup_job_id: string;
  node_id: string;
  lease_expires_at: string;
};

type VerifiedArtifact = StoredArtifact & {
  object_key: string;
  object_version: string;
};

type UploadResult = {
  lease_token: string;
  state: "running" | "verified" | "failed";
  error_code: string | null;
  artifacts: VerifiedArtifact[] | null;
};

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/+"=-]{0,255}$/;
const ARTIFACTS: Readonly<Record<ArtifactKind, string>> = {
  database_dump: "database.dump",
  filestore_archive: "filestore.tar.gz",
  manifest: "manifest.json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function authenticateNode(request: Request, env: Env, nodeId: string): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL
        AND agent_token_hash = ?`,
  ).bind(nodeId, tokenHash).first<{ id: string }>();
  return Boolean(row);
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseSeconds(env: Env): number {
  const parsed = Number(env.NODE_OPERATION_LEASE_SECONDS || 600);
  if (!Number.isFinite(parsed)) return 600;
  return Math.max(120, Math.min(1800, Math.trunc(parsed)));
}

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  return `${prefix}_${base64}`;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, error: string): void {
  if (Object.keys(value).some((key) => !expected.has(key)) || Object.keys(value).length !== expected.size) {
    throw new Error(error);
  }
}

function stringValue(value: unknown, maxLength: number, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  const parsed = value.trim();
  if (!parsed || parsed.length > maxLength) throw new Error(error);
  return parsed;
}

function integerValue(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(error);
  return value;
}

export function expectedBackupObjectKey(
  tenantId: string,
  backupJobId: string,
  artifactKind: ArtifactKind,
): string {
  return `test/${tenantId}/${backupJobId}/${ARTIFACTS[artifactKind]}`;
}

export function buildBackupUploadOperationPayload(
  source: UploadSource,
  artifacts: StoredArtifact[],
): Record<string, unknown> {
  return {
    tenant_id: source.tenant_id,
    environment_kind: source.environment_kind,
    template_id: source.template_id,
    provisioning_operation_id: source.provisioning_job_id,
    database_name: source.database_name,
    backup_type: source.backup_type,
    manifest_sha256: source.manifest_sha256,
    total_size_bytes: source.total_size_bytes,
    artifacts: artifacts.map((item) => ({
      artifact_kind: item.artifact_kind,
      size_bytes: item.size_bytes,
      sha256: item.sha256,
    })),
  };
}

function parseVerifiedArtifacts(value: unknown): VerifiedArtifact[] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("invalid_backup_upload_artifacts");
  const parsed: VerifiedArtifact[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid_backup_upload_artifact");
    }
    const item = raw as Record<string, unknown>;
    exactKeys(
      item,
      new Set(["artifact_kind", "size_bytes", "sha256", "object_key", "object_version"]),
      "invalid_backup_upload_artifact_fields",
    );
    const kind = stringValue(item.artifact_kind, 32, "invalid_artifact_kind") as ArtifactKind;
    if (!Object.hasOwn(ARTIFACTS, kind) || seen.has(kind)) throw new Error("invalid_artifact_kind");
    const size = integerValue(item.size_bytes, "invalid_artifact_size_bytes");
    const checksum = stringValue(item.sha256, 64, "invalid_artifact_sha256").toLowerCase();
    if (!SHA256.test(checksum)) throw new Error("invalid_artifact_sha256");
    const objectKey = stringValue(item.object_key, 512, "invalid_object_key");
    const objectVersion = stringValue(item.object_version, 256, "invalid_object_version");
    if (!SAFE_VERSION.test(objectVersion)) throw new Error("invalid_object_version");
    seen.add(kind);
    parsed.push({
      artifact_kind: kind,
      size_bytes: size,
      sha256: checksum,
      object_key: objectKey,
      object_version: objectVersion,
    });
  }
  if (seen.size !== 3) throw new Error("invalid_backup_upload_artifacts");
  return parsed;
}

export function parseBackupUploadResult(input: Record<string, unknown>): UploadResult {
  const leaseToken = stringValue(input.lease_token, 256, "invalid_lease_token");
  if (leaseToken.length < 16) throw new Error("invalid_lease_token");
  const state = stringValue(input.state, 32, "invalid_backup_upload_state").toLowerCase();

  if (state === "running") {
    exactKeys(input, new Set(["lease_token", "state"]), "invalid_backup_upload_running_fields");
    return { lease_token: leaseToken, state: "running", error_code: null, artifacts: null };
  }

  if (state === "failed") {
    exactKeys(input, new Set(["lease_token", "state", "error_code"]), "invalid_backup_upload_failed_fields");
    const errorCode = stringValue(input.error_code, 120, "invalid_error_code").toLowerCase();
    if (!SAFE_CODE.test(errorCode)) throw new Error("invalid_error_code");
    return { lease_token: leaseToken, state: "failed", error_code: errorCode, artifacts: null };
  }

  if (state === "verified") {
    exactKeys(input, new Set(["lease_token", "state", "artifacts"]), "invalid_backup_upload_verified_fields");
    return {
      lease_token: leaseToken,
      state: "verified",
      error_code: null,
      artifacts: parseVerifiedArtifacts(input.artifacts),
    };
  }

  throw new Error("invalid_backup_upload_state");
}

async function storedArtifacts(env: Env, backupJobId: string): Promise<StoredArtifact[]> {
  const result = await env.DB.prepare(
    `SELECT artifact_kind, size_bytes, sha256
       FROM backup_artifacts
      WHERE backup_job_id = ?
      ORDER BY artifact_kind ASC`,
  ).bind(backupJobId).all<StoredArtifact>();
  return result.results;
}

async function markExpiredUploadLeases(env: Env, nodeId: string): Promise<void> {
  const now = nowIso();
  const expired = await env.DB.prepare(
    `SELECT backup_job_id FROM backup_upload_leases
      WHERE node_id = ? AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC LIMIT 20`,
  ).bind(nodeId, now).all<{ backup_job_id: string }>();
  for (const row of expired.results) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM backup_upload_leases WHERE backup_job_id = ?`).bind(row.backup_job_id),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.upload.lease_expired', 'prepared', 'prepared', '{}', ?)`,
      ).bind(crypto.randomUUID(), row.backup_job_id, now),
    ]);
  }
}

async function claimBackupUpload(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response | null> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }

  await markExpiredUploadLeases(env, nodeId);
  const leaseToken = randomSecret("dsx_backup_upload_lease");
  const leaseHash = await sha256(leaseToken);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO backup_upload_leases
       (backup_job_id, node_id, lease_token_hash, lease_expires_at, created_at, updated_at)
     SELECT j.id, j.node_id, ?, ?, ?, ?
       FROM backup_jobs j
      WHERE j.node_id = ? AND j.state = 'prepared'
        AND j.environment_kind = 'test' AND j.backup_type = 'full'
        AND j.manifest_sha256 IS NOT NULL AND j.total_size_bytes IS NOT NULL
        AND (SELECT COUNT(*) FROM backup_artifacts a
              WHERE a.backup_job_id = j.id AND a.size_bytes IS NOT NULL AND a.sha256 IS NOT NULL) = 3
        AND NOT EXISTS (
          SELECT 1 FROM backup_upload_leases existing WHERE existing.backup_job_id = j.id
        )
      ORDER BY j.prepared_at ASC, j.created_at ASC
      LIMIT 1
     RETURNING backup_job_id`,
  ).bind(leaseHash, expiresAt, now, now, nodeId).first<{ backup_job_id: string }>();
  if (!claimed) return null;

  const source = await env.DB.prepare(
    `SELECT id AS backup_job_id, tenant_id, provisioning_job_id, template_id, node_id,
            database_name, environment_kind, backup_type, state, manifest_sha256,
            total_size_bytes
       FROM backup_jobs WHERE id = ? AND node_id = ?`,
  ).bind(claimed.backup_job_id, nodeId).first<UploadSource>();
  const artifacts = await storedArtifacts(env, claimed.backup_job_id);
  if (!source || source.state !== "prepared" || artifacts.length !== 3) {
    await env.DB.prepare(`DELETE FROM backup_upload_leases WHERE backup_job_id = ?`)
      .bind(claimed.backup_job_id).run();
    return json({ error: "backup_upload_claim_conflict" }, 409);
  }

  const payload = buildBackupUploadOperationPayload(source, artifacts);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE backup_jobs SET error_code = NULL, updated_at = ? WHERE id = ? AND state = 'prepared'`,
    ).bind(now, source.backup_job_id),
    env.DB.prepare(
      `INSERT INTO backup_job_events
        (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'backup.upload.dispatched', 'prepared', 'prepared', ?, ?)`,
    ).bind(crypto.randomUUID(), source.backup_job_id, JSON.stringify({ node_id: nodeId }), now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'backup.upload.claimed', 'node', ?, 'backup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      source.backup_job_id,
      JSON.stringify({ operation_type: "upload_verify_backup_artifacts" }),
      now,
    ),
  ]);

  return json({
    operation: {
      id: source.backup_job_id,
      type: "upload_verify_backup_artifacts",
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      payload,
    },
  });
}

function matchesStoredArtifacts(
  tenantId: string,
  backupJobId: string,
  stored: StoredArtifact[],
  returned: VerifiedArtifact[],
): boolean {
  if (stored.length !== 3 || returned.length !== 3) return false;
  const storedMap = new Map(stored.map((item) => [item.artifact_kind, item]));
  for (const item of returned) {
    const expected = storedMap.get(item.artifact_kind);
    if (!expected || expected.size_bytes !== item.size_bytes || expected.sha256 !== item.sha256) {
      return false;
    }
    if (item.object_key !== expectedBackupObjectKey(tenantId, backupJobId, item.artifact_kind)) {
      return false;
    }
  }
  return true;
}

async function verifiedReplayMatches(
  env: Env,
  nodeId: string,
  backupJobId: string,
  input: UploadResult,
): Promise<boolean> {
  if (input.state !== "verified" || !input.artifacts) return false;
  const job = await env.DB.prepare(
    `SELECT tenant_id, node_id, state FROM backup_jobs WHERE id = ?`,
  ).bind(backupJobId).first<{ tenant_id: string; node_id: string; state: string }>();
  if (!job || job.node_id !== nodeId || job.state !== "verified") return false;
  const stored = await env.DB.prepare(
    `SELECT artifact_kind, size_bytes, sha256, object_key, object_version
       FROM backup_artifacts WHERE backup_job_id = ? ORDER BY artifact_kind ASC`,
  ).bind(backupJobId).all<VerifiedArtifact>();
  if (stored.results.length !== 3) return false;
  const left = [...stored.results].sort((a, b) => a.artifact_kind.localeCompare(b.artifact_kind));
  const right = [...input.artifacts].sort((a, b) => a.artifact_kind.localeCompare(b.artifact_kind));
  return left.every((item, index) =>
    item.artifact_kind === right[index].artifact_kind &&
    item.size_bytes === right[index].size_bytes &&
    item.sha256 === right[index].sha256 &&
    item.object_key === right[index].object_key &&
    item.object_version === right[index].object_version
  );
}

async function reportBackupUploadResult(
  request: Request,
  env: Env,
  nodeId: string,
  backupJobId: string,
): Promise<Response | null> {
  const leaseExists = await env.DB.prepare(
    `SELECT backup_job_id FROM backup_upload_leases WHERE backup_job_id = ? AND node_id = ?`,
  ).bind(backupJobId, nodeId).first<{ backup_job_id: string }>();
  const jobState = await env.DB.prepare(
    `SELECT state FROM backup_jobs WHERE id = ? AND node_id = ?`,
  ).bind(backupJobId, nodeId).first<{ state: string }>();
  if (!leaseExists && jobState?.state !== "verified") return null;

  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: UploadResult;
  try {
    input = parseBackupUploadResult(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_backup_upload_result" }, 400);
  }

  if (!leaseExists && await verifiedReplayMatches(env, nodeId, backupJobId, input)) {
    return json({ accepted: true, state: "verified", idempotent_replay: true });
  }

  const leaseHash = await sha256(input.lease_token);
  const now = nowIso();
  const lease = await env.DB.prepare(
    `SELECT backup_job_id, node_id, lease_expires_at
       FROM backup_upload_leases
      WHERE backup_job_id = ? AND node_id = ? AND lease_token_hash = ?`,
  ).bind(backupJobId, nodeId, leaseHash).first<UploadLeaseRow>();
  if (!lease) return json({ error: "invalid_backup_upload_lease" }, 409);
  if (lease.lease_expires_at <= now) {
    await env.DB.prepare(`DELETE FROM backup_upload_leases WHERE backup_job_id = ?`).bind(backupJobId).run();
    return json({ error: "backup_upload_lease_expired" }, 409);
  }

  if (input.state === "running") {
    const nextExpiry = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE backup_upload_leases SET lease_expires_at = ?, updated_at = ? WHERE backup_job_id = ?`,
    ).bind(nextExpiry, now, backupJobId).run();
    return json({ accepted: true, state: "prepared", lease_expires_at: nextExpiry });
  }

  if (input.state === "failed") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE backup_jobs SET error_code = ?, updated_at = ? WHERE id = ? AND state = 'prepared'`,
      ).bind(input.error_code, now, backupJobId),
      env.DB.prepare(`DELETE FROM backup_upload_leases WHERE backup_job_id = ?`).bind(backupJobId),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.upload.failed', 'prepared', 'prepared', ?, ?)`,
      ).bind(crypto.randomUUID(), backupJobId, JSON.stringify({ error_code: input.error_code }), now),
    ]);
    return json({ accepted: true, state: "prepared", retryable: true });
  }

  const job = await env.DB.prepare(
    `SELECT tenant_id, state FROM backup_jobs WHERE id = ? AND node_id = ?`,
  ).bind(backupJobId, nodeId).first<{ tenant_id: string; state: string }>();
  if (!job || job.state !== "prepared" || !input.artifacts) {
    return json({ error: "backup_upload_state_conflict" }, 409);
  }
  const stored = await storedArtifacts(env, backupJobId);
  if (!matchesStoredArtifacts(job.tenant_id, backupJobId, stored, input.artifacts)) {
    return json({ error: "backup_upload_artifact_mismatch" }, 409);
  }

  const updates = input.artifacts.map((item) =>
    env.DB.prepare(
      `UPDATE backup_artifacts
          SET object_key = ?, object_version = ?, updated_at = ?
        WHERE backup_job_id = ? AND artifact_kind = ? AND size_bytes = ? AND sha256 = ?`,
    ).bind(
      item.object_key,
      item.object_version,
      now,
      backupJobId,
      item.artifact_kind,
      item.size_bytes,
      item.sha256,
    ),
  );

  await env.DB.batch([
    ...updates,
    env.DB.prepare(
      `UPDATE backup_jobs
          SET state = 'verified', error_code = NULL, uploaded_at = ?, verified_at = ?,
              finished_at = ?, updated_at = ?
        WHERE id = ? AND state = 'prepared'`,
    ).bind(now, now, now, now, backupJobId),
    env.DB.prepare(`DELETE FROM backup_upload_leases WHERE backup_job_id = ?`).bind(backupJobId),
    env.DB.prepare(
      `INSERT INTO backup_job_events
        (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'backup.uploaded', 'prepared', 'uploaded', '{}', ?)`,
    ).bind(crypto.randomUUID(), backupJobId, now),
    env.DB.prepare(
      `INSERT INTO backup_job_events
        (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'backup.verified', 'uploaded', 'verified', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      backupJobId,
      JSON.stringify({ object_keys: input.artifacts.map((item) => item.object_key) }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'backup.verified', 'node', ?, 'backup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      backupJobId,
      JSON.stringify({ artifact_count: input.artifacts.length }),
      now,
    ),
  ]);

  return json({ accepted: true, state: "verified", idempotent_replay: false });
}

export async function handleBackupUploadOperationRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const claim = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/operations\/claim$/i);
  if (request.method === "POST" && claim) {
    return await claimBackupUpload(request, env, claim[1]);
  }

  const result = url.pathname.match(
    /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
  );
  if (request.method === "POST" && result) {
    return await reportBackupUploadResult(request, env, result[1], result[2]);
  }

  return null;
}
