interface Env {
  DB: D1Database;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

type ArtifactKind = "database_dump" | "filestore_archive" | "manifest";

type RestoreJobSource = {
  restore_job_id: string;
  backup_job_id: string;
  source_tenant_id: string;
  target_tenant_id: string;
  template_id: string;
  node_id: string;
  source_provisioning_operation_id: string;
  source_database_name: string;
  target_database_name: string;
  environment_kind: string;
  state: string;
  manifest_sha256: string;
  total_size_bytes: number;
};

type RestoreArtifact = {
  artifact_kind: ArtifactKind;
  object_key: string;
  object_version: string;
  size_bytes: number;
  sha256: string;
};

type RestoreLeaseRow = {
  restore_job_id: string;
  node_id: string;
  lease_token_hash: string;
  lease_expires_at: string;
};

type RestoreResult = {
  lease_token: string;
  state: "running" | "validated" | "failed";
  error_code: string | null;
  database_name: string | null;
};

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{2,62}$/;
const ARTIFACT_FILES: Readonly<Record<ArtifactKind, string>> = {
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

export function expectedRestoreObjectKey(
  sourceTenantId: string,
  backupJobId: string,
  artifactKind: ArtifactKind,
): string {
  return `test/${sourceTenantId}/${backupJobId}/${ARTIFACT_FILES[artifactKind]}`;
}

export function buildRestoreOperationPayload(
  source: RestoreJobSource,
  artifacts: RestoreArtifact[],
): Record<string, unknown> {
  return {
    backup_job_id: source.backup_job_id,
    source_tenant_id: source.source_tenant_id,
    target_tenant_id: source.target_tenant_id,
    environment_kind: source.environment_kind,
    template_id: source.template_id,
    source_provisioning_operation_id: source.source_provisioning_operation_id,
    source_database_name: source.source_database_name,
    target_database_name: source.target_database_name,
    manifest_sha256: source.manifest_sha256,
    total_size_bytes: source.total_size_bytes,
    artifacts: artifacts.map((item) => ({
      artifact_kind: item.artifact_kind,
      object_key: item.object_key,
      object_version: item.object_version,
      size_bytes: item.size_bytes,
      sha256: item.sha256,
    })),
  };
}

export function parseRestoreResult(input: Record<string, unknown>): RestoreResult {
  const leaseToken = stringValue(input.lease_token, 256, "invalid_lease_token");
  if (leaseToken.length < 16) throw new Error("invalid_lease_token");
  const state = stringValue(input.state, 32, "invalid_restore_state").toLowerCase();

  if (state === "running") {
    exactKeys(input, new Set(["lease_token", "state"]), "invalid_restore_running_fields");
    return { lease_token: leaseToken, state: "running", error_code: null, database_name: null };
  }

  if (state === "failed") {
    exactKeys(input, new Set(["lease_token", "state", "error_code"]), "invalid_restore_failed_fields");
    const errorCode = stringValue(input.error_code, 120, "invalid_error_code").toLowerCase();
    if (!SAFE_CODE.test(errorCode)) throw new Error("invalid_error_code");
    return { lease_token: leaseToken, state: "failed", error_code: errorCode, database_name: null };
  }

  if (state === "validated") {
    exactKeys(input, new Set(["lease_token", "state", "database_name"]), "invalid_restore_validated_fields");
    const databaseName = stringValue(input.database_name, 63, "invalid_database_name").toLowerCase();
    if (!SAFE_DATABASE.test(databaseName)) throw new Error("invalid_database_name");
    return { lease_token: leaseToken, state: "validated", error_code: null, database_name: databaseName };
  }

  throw new Error("invalid_restore_state");
}

async function markExpiredRestoreLeases(env: Env, nodeId: string): Promise<void> {
  const now = nowIso();
  const expired = await env.DB.prepare(
    `SELECT l.restore_job_id, j.state
       FROM restore_operation_leases l
       JOIN restore_jobs j ON j.id = l.restore_job_id
      WHERE l.node_id = ? AND l.lease_expires_at <= ?
      ORDER BY l.lease_expires_at ASC
      LIMIT 20`,
  ).bind(nodeId, now).all<{ restore_job_id: string; state: string }>();

  for (const row of expired.results) {
    const fromState = row.state === "running" || row.state === "dispatched" ? row.state : "queued";
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`).bind(row.restore_job_id),
      env.DB.prepare(
        `UPDATE restore_jobs
            SET state = 'queued', updated_at = ?, error_code = NULL
          WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(now, row.restore_job_id),
      env.DB.prepare(
        `INSERT INTO restore_job_events
          (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'restore.lease_expired', ?, 'queued', '{}', ?)`,
      ).bind(crypto.randomUUID(), row.restore_job_id, fromState, now),
    ]);
  }
}

async function restoreSource(env: Env, restoreJobId: string, nodeId: string): Promise<RestoreJobSource | null> {
  return await env.DB.prepare(
    `SELECT r.id AS restore_job_id,
            r.backup_job_id,
            r.source_tenant_id,
            r.target_tenant_id,
            r.template_id,
            r.node_id,
            b.provisioning_job_id AS source_provisioning_operation_id,
            r.source_database_name,
            r.target_database_name,
            r.environment_kind,
            r.state,
            b.manifest_sha256,
            b.total_size_bytes
       FROM restore_jobs r
       JOIN backup_jobs b ON b.id = r.backup_job_id
      WHERE r.id = ? AND r.node_id = ?
        AND b.state = 'verified'`,
  ).bind(restoreJobId, nodeId).first<RestoreJobSource>();
}

async function restoreArtifacts(env: Env, backupJobId: string): Promise<RestoreArtifact[]> {
  const result = await env.DB.prepare(
    `SELECT artifact_kind, object_key, object_version, size_bytes, sha256
       FROM backup_artifacts
      WHERE backup_job_id = ?
      ORDER BY artifact_kind ASC`,
  ).bind(backupJobId).all<RestoreArtifact>();
  return result.results;
}

function artifactsAreValid(source: RestoreJobSource, artifacts: RestoreArtifact[]): boolean {
  if (artifacts.length !== 3 || source.environment_kind !== "test") return false;
  if (!source.manifest_sha256 || !SHA256.test(source.manifest_sha256)) return false;
  if (!Number.isSafeInteger(source.total_size_bytes) || source.total_size_bytes < 0) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const artifact of artifacts) {
    if (!Object.hasOwn(ARTIFACT_FILES, artifact.artifact_kind) || seen.has(artifact.artifact_kind)) return false;
    if (!artifact.object_key || !artifact.object_version) return false;
    if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0) return false;
    if (!SHA256.test(artifact.sha256)) return false;
    if (artifact.object_key !== expectedRestoreObjectKey(
      source.source_tenant_id,
      source.backup_job_id,
      artifact.artifact_kind,
    )) return false;
    seen.add(artifact.artifact_kind);
    total += artifact.size_bytes;
  }
  const manifest = artifacts.find((item) => item.artifact_kind === "manifest");
  return seen.size === 3 && total === source.total_size_bytes && manifest?.sha256 === source.manifest_sha256;
}

async function claimRestore(request: Request, env: Env, nodeId: string): Promise<Response | null> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }

  await markExpiredRestoreLeases(env, nodeId);
  const leaseToken = randomSecret("dsx_restore_lease");
  const leaseHash = await sha256(leaseToken);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();

  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO restore_operation_leases
       (restore_job_id, node_id, lease_token_hash, lease_expires_at, created_at, updated_at)
     SELECT r.id, r.node_id, ?, ?, ?, ?
       FROM restore_jobs r
       JOIN backup_jobs b ON b.id = r.backup_job_id
      WHERE r.node_id = ? AND r.state = 'queued'
        AND r.environment_kind = 'test' AND b.state = 'verified'
        AND NOT EXISTS (
          SELECT 1 FROM restore_operation_leases existing WHERE existing.restore_job_id = r.id
        )
      ORDER BY r.created_at ASC
      LIMIT 1
     RETURNING restore_job_id`,
  ).bind(leaseHash, expiresAt, now, now, nodeId).first<{ restore_job_id: string }>();
  if (!claimed) return null;

  const source = await restoreSource(env, claimed.restore_job_id, nodeId);
  if (!source) {
    await env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`)
      .bind(claimed.restore_job_id).run();
    return json({ error: "restore_claim_conflict" }, 409);
  }
  const artifacts = await restoreArtifacts(env, source.backup_job_id);
  if (!artifactsAreValid(source, artifacts)) {
    await env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`)
      .bind(source.restore_job_id).run();
    return json({ error: "restore_artifacts_invalid" }, 409);
  }

  const updated = await env.DB.prepare(
    `UPDATE restore_jobs
        SET state = 'dispatched', attempt = attempt + 1, error_code = NULL, updated_at = ?
      WHERE id = ? AND state = 'queued'
      RETURNING id`,
  ).bind(now, source.restore_job_id).first<{ id: string }>();
  if (!updated) {
    await env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`)
      .bind(source.restore_job_id).run();
    return json({ error: "restore_claim_conflict" }, 409);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO restore_job_events
        (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'restore.dispatched', 'queued', 'dispatched', ?, ?)`,
    ).bind(crypto.randomUUID(), source.restore_job_id, JSON.stringify({ node_id: nodeId }), now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'restore.claimed', 'node', ?, 'restore_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      source.restore_job_id,
      JSON.stringify({ operation_type: "restore_verified_backup", backup_job_id: source.backup_job_id }),
      now,
    ),
  ]);

  return json({
    operation: {
      id: source.restore_job_id,
      type: "restore_verified_backup",
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      payload: buildRestoreOperationPayload(source, artifacts),
    },
  });
}

async function validatedReplayMatches(
  env: Env,
  nodeId: string,
  restoreJobId: string,
  input: RestoreResult,
): Promise<boolean> {
  if (input.state !== "validated" || !input.database_name) return false;
  const row = await env.DB.prepare(
    `SELECT node_id, target_database_name, state
       FROM restore_jobs WHERE id = ?`,
  ).bind(restoreJobId).first<{ node_id: string; target_database_name: string; state: string }>();
  return Boolean(
    row && row.node_id === nodeId && row.state === "validated" &&
    row.target_database_name === input.database_name
  );
}

async function reportRestoreResult(
  request: Request,
  env: Env,
  nodeId: string,
  restoreJobId: string,
): Promise<Response> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: RestoreResult;
  try {
    input = parseRestoreResult(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_restore_result" }, 400);
  }

  const lease = await env.DB.prepare(
    `SELECT restore_job_id, node_id, lease_token_hash, lease_expires_at
       FROM restore_operation_leases
      WHERE restore_job_id = ? AND node_id = ?`,
  ).bind(restoreJobId, nodeId).first<RestoreLeaseRow>();

  if (!lease) {
    if (await validatedReplayMatches(env, nodeId, restoreJobId, input)) {
      return json({ accepted: true, state: "validated", idempotent_replay: true });
    }
    return json({ error: "restore_lease_not_found" }, 409);
  }
  if (lease.lease_expires_at <= nowIso()) return json({ error: "restore_lease_expired" }, 409);
  if (await sha256(input.lease_token) !== lease.lease_token_hash) {
    return json({ error: "invalid_restore_lease" }, 401);
  }

  const job = await env.DB.prepare(
    `SELECT id, target_tenant_id, node_id, target_database_name, state
       FROM restore_jobs WHERE id = ? AND node_id = ?`,
  ).bind(restoreJobId, nodeId).first<{
    id: string;
    target_tenant_id: string;
    node_id: string;
    target_database_name: string;
    state: string;
  }>();
  if (!job) return json({ error: "restore_job_not_found" }, 404);

  const now = nowIso();
  if (input.state === "running") {
    const nextExpiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE restore_operation_leases SET lease_expires_at = ?, updated_at = ?
          WHERE restore_job_id = ? AND node_id = ?`,
      ).bind(nextExpiresAt, now, restoreJobId, nodeId),
      env.DB.prepare(
        `UPDATE restore_jobs
            SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(now, now, restoreJobId),
    ]);
    if (job.state === "dispatched") {
      await env.DB.prepare(
        `INSERT INTO restore_job_events
          (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'restore.running', 'dispatched', 'running', '{}', ?)`,
      ).bind(crypto.randomUUID(), restoreJobId, now).run();
    }
    return json({ accepted: true, state: "running", lease_expires_at: nextExpiresAt });
  }

  if (input.state === "failed") {
    if (!input.error_code) return json({ error: "invalid_error_code" }, 400);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`).bind(restoreJobId),
      env.DB.prepare(
        `UPDATE restore_jobs
            SET state = 'failed', error_code = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(input.error_code, now, now, restoreJobId),
      env.DB.prepare(
        `UPDATE tenants
            SET status = 'failed', assigned_node_id = NULL, database_name = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(now, job.target_tenant_id),
      env.DB.prepare(
        `INSERT INTO restore_job_events
          (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'restore.failed', ?, 'failed', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        restoreJobId,
        job.state === "dispatched" ? "dispatched" : "running",
        JSON.stringify({ error_code: input.error_code }),
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
         VALUES (?, 'restore.failed', 'node', ?, 'restore_job', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), nodeId, restoreJobId, JSON.stringify({ error_code: input.error_code }), now),
    ]);
    return json({ accepted: true, state: "failed" });
  }

  if (!input.database_name || input.database_name !== job.target_database_name) {
    return json({ error: "restore_database_name_mismatch" }, 409);
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM restore_operation_leases WHERE restore_job_id = ?`).bind(restoreJobId),
    env.DB.prepare(
      `UPDATE restore_jobs
          SET state = 'validated', error_code = NULL, updated_at = ?, restored_at = ?,
              validated_at = ?, finished_at = ?
        WHERE id = ? AND state IN ('dispatched', 'running')`,
    ).bind(now, now, now, now, restoreJobId),
    env.DB.prepare(
      `UPDATE tenants
          SET status = 'ready', assigned_node_id = ?, database_name = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(nodeId, job.target_database_name, now, job.target_tenant_id),
    env.DB.prepare(
      `INSERT INTO restore_job_events
        (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'restore.restored', ?, 'restored', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      restoreJobId,
      job.state === "dispatched" ? "dispatched" : "running",
      JSON.stringify({ database_name: job.target_database_name }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO restore_job_events
        (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'restore.validated', 'restored', 'validated', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      restoreJobId,
      JSON.stringify({ database_name: job.target_database_name }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'restore.validated', 'node', ?, 'restore_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      restoreJobId,
      JSON.stringify({ target_tenant_id: job.target_tenant_id, database_name: job.target_database_name }),
      now,
    ),
  ]);
  return json({ accepted: true, state: "validated", idempotent_replay: false });
}

export async function handleRestoreOperationRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const claim = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/operations\/claim$/i);
  if (request.method === "POST" && claim) {
    return await claimRestore(request, env, claim[1]);
  }

  const result = url.pathname.match(
    /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
  );
  if (request.method === "POST" && result) {
    return await reportRestoreResult(request, env, result[1], result[2]);
  }

  return null;
}
