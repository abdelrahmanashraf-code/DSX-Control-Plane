interface Env {
  DB: D1Database;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

type BackupClaimRow = { backup_job_id: string };
type BackupSourceRow = {
  backup_job_id: string;
  tenant_id: string;
  provisioning_job_id: string;
  template_id: string;
  node_id: string;
  database_name: string;
  environment_kind: string;
  backup_type: string;
  state: string;
};
type BackupLeaseRow = {
  backup_job_id: string;
  node_id: string;
  lease_expires_at: string;
};
type BackupArtifactInput = {
  artifact_kind: "database_dump" | "filestore_archive" | "manifest";
  size_bytes: number;
  sha256: string;
};

type BackupOperationResultInput = {
  lease_token: string;
  state: "running" | "prepared" | "failed";
  error_code: string | null;
  artifacts: BackupArtifactInput[] | null;
  manifest_sha256: string | null;
  total_size_bytes: number | null;
};

const encoder = new TextEncoder();
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_KINDS = new Set(["database_dump", "filestore_archive", "manifest"]);

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

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  return `${prefix}_${base64}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseSeconds(env: Env): number {
  const parsed = Number(env.NODE_OPERATION_LEASE_SECONDS || 600);
  if (!Number.isFinite(parsed)) return 600;
  return Math.max(120, Math.min(1800, Math.trunc(parsed)));
}

export function buildBackupOperationPayload(source: BackupSourceRow): Record<string, unknown> {
  return {
    tenant_id: source.tenant_id,
    environment_kind: source.environment_kind,
    template_id: source.template_id,
    provisioning_operation_id: source.provisioning_job_id,
    database_name: source.database_name,
    backup_type: source.backup_type,
  };
}

function parseArtifacts(value: unknown): BackupArtifactInput[] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("invalid_backup_artifacts");
  const parsed: BackupArtifactInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid_backup_artifact");
    }
    const item = raw as Record<string, unknown>;
    if (new Set(Object.keys(item)).size !== 3 || !Object.hasOwn(item, "artifact_kind") ||
        !Object.hasOwn(item, "size_bytes") || !Object.hasOwn(item, "sha256")) {
      throw new Error("invalid_backup_artifact_fields");
    }
    const kind = typeof item.artifact_kind === "string" ? item.artifact_kind.trim() : "";
    if (!ARTIFACT_KINDS.has(kind) || seen.has(kind)) throw new Error("invalid_artifact_kind");
    const size = item.size_bytes;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("invalid_artifact_size_bytes");
    }
    const checksum = typeof item.sha256 === "string" ? item.sha256.trim().toLowerCase() : "";
    if (!SHA256.test(checksum)) throw new Error("invalid_artifact_sha256");
    seen.add(kind);
    parsed.push({
      artifact_kind: kind as BackupArtifactInput["artifact_kind"],
      size_bytes: size,
      sha256: checksum,
    });
  }
  if (seen.size !== 3) throw new Error("invalid_backup_artifacts");
  return parsed;
}

export function parseBackupOperationResult(input: Record<string, unknown>): BackupOperationResultInput {
  const leaseToken = typeof input.lease_token === "string" ? input.lease_token.trim().slice(0, 256) : "";
  const state = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  if (leaseToken.length < 16) throw new Error("invalid_lease_token");

  if (state === "running") {
    if (Object.keys(input).some((key) => !new Set(["lease_token", "state"]).has(key))) {
      throw new Error("invalid_backup_running_fields");
    }
    return {
      lease_token: leaseToken,
      state: "running",
      error_code: null,
      artifacts: null,
      manifest_sha256: null,
      total_size_bytes: null,
    };
  }

  if (state === "failed") {
    if (Object.keys(input).some((key) => !new Set(["lease_token", "state", "error_code"]).has(key))) {
      throw new Error("invalid_backup_failed_fields");
    }
    const errorCode = typeof input.error_code === "string" ? input.error_code.trim().toLowerCase() : "";
    if (!SAFE_CODE.test(errorCode)) throw new Error("invalid_error_code");
    return {
      lease_token: leaseToken,
      state: "failed",
      error_code: errorCode,
      artifacts: null,
      manifest_sha256: null,
      total_size_bytes: null,
    };
  }

  if (state === "prepared") {
    const allowed = new Set(["lease_token", "state", "artifacts", "manifest_sha256", "total_size_bytes"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new Error("invalid_backup_prepared_fields");
    }
    const manifestSha = typeof input.manifest_sha256 === "string"
      ? input.manifest_sha256.trim().toLowerCase()
      : "";
    if (!SHA256.test(manifestSha)) throw new Error("invalid_manifest_sha256");
    const totalSize = input.total_size_bytes;
    if (typeof totalSize !== "number" || !Number.isSafeInteger(totalSize) || totalSize < 0) {
      throw new Error("invalid_total_size_bytes");
    }
    const artifacts = parseArtifacts(input.artifacts);
    if (artifacts.reduce((sum, item) => sum + item.size_bytes, 0) !== totalSize) {
      throw new Error("backup_total_size_mismatch");
    }
    const manifest = artifacts.find((item) => item.artifact_kind === "manifest");
    if (!manifest || manifest.sha256 !== manifestSha) {
      throw new Error("backup_manifest_checksum_mismatch");
    }
    return {
      lease_token: leaseToken,
      state: "prepared",
      error_code: null,
      artifacts,
      manifest_sha256: manifestSha,
      total_size_bytes: totalSize,
    };
  }

  throw new Error("invalid_backup_operation_state");
}

async function markExpiredBackupLeases(env: Env, nodeId: string): Promise<void> {
  const now = nowIso();
  const expired = await env.DB.prepare(
    `SELECT l.backup_job_id
       FROM backup_operation_leases l
       JOIN backup_jobs j ON j.id = l.backup_job_id
      WHERE l.node_id = ? AND l.lease_expires_at <= ?
        AND j.state IN ('dispatched', 'running')
      ORDER BY l.lease_expires_at ASC
      LIMIT 20`,
  ).bind(nodeId, now).all<{ backup_job_id: string }>();

  for (const row of expired.results) {
    const current = await env.DB.prepare(
      `SELECT state FROM backup_jobs WHERE id = ?`,
    ).bind(row.backup_job_id).first<{ state: string }>();
    if (!current) continue;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE backup_jobs SET state = 'failed', error_code = 'operation_lease_expired',
          updated_at = ?, finished_at = ? WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(now, now, row.backup_job_id),
      env.DB.prepare(`DELETE FROM backup_operation_leases WHERE backup_job_id = ?`).bind(row.backup_job_id),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.failed', ?, 'failed', '{"error_code":"operation_lease_expired"}', ?)`,
      ).bind(crypto.randomUUID(), row.backup_job_id, current.state, now),
    ]);
  }
}

async function claimBackupOperation(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response | null> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }

  await markExpiredBackupLeases(env, nodeId);
  const leaseToken = randomSecret("dsx_backup_lease");
  const leaseHash = await sha256(leaseToken);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();

  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO backup_operation_leases
       (backup_job_id, node_id, lease_token_hash, lease_expires_at, created_at, updated_at)
     SELECT j.id, j.node_id, ?, ?, ?, ?
       FROM backup_jobs j
      WHERE j.node_id = ? AND j.state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM backup_operation_leases existing WHERE existing.backup_job_id = j.id
        )
      ORDER BY j.created_at ASC
      LIMIT 1
     RETURNING backup_job_id`,
  ).bind(leaseHash, expiresAt, now, now, nodeId).first<BackupClaimRow>();

  if (!claimed) return null;

  const source = await env.DB.prepare(
    `SELECT id AS backup_job_id, tenant_id, provisioning_job_id, template_id, node_id,
            database_name, environment_kind, backup_type, state
       FROM backup_jobs
      WHERE id = ? AND node_id = ?`,
  ).bind(claimed.backup_job_id, nodeId).first<BackupSourceRow>();

  if (!source || source.state !== "queued" || source.environment_kind !== "test" || source.backup_type !== "full") {
    await env.DB.prepare(`DELETE FROM backup_operation_leases WHERE backup_job_id = ?`)
      .bind(claimed.backup_job_id).run();
    return json({ error: "backup_operation_claim_conflict" }, 409);
  }

  const payload = buildBackupOperationPayload(source);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE backup_jobs SET state = 'dispatched', attempt = attempt + 1,
        error_code = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`,
    ).bind(now, source.backup_job_id),
    env.DB.prepare(
      `INSERT INTO backup_job_events
        (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'backup.dispatched', 'queued', 'dispatched', ?, ?)`,
    ).bind(crypto.randomUUID(), source.backup_job_id, JSON.stringify({ node_id: nodeId }), now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'backup.operation.claimed', 'node', ?, 'backup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      source.backup_job_id,
      JSON.stringify({ operation_type: "backup_odoo_environment" }),
      now,
    ),
  ]);

  return json({
    operation: {
      id: source.backup_job_id,
      type: "backup_odoo_environment",
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      payload,
    },
  });
}

async function preparedReplayMatches(
  env: Env,
  backupJobId: string,
  input: BackupOperationResultInput,
): Promise<boolean> {
  if (input.state !== "prepared" || !input.artifacts || !input.manifest_sha256 || input.total_size_bytes === null) {
    return false;
  }
  const current = await env.DB.prepare(
    `SELECT state, manifest_sha256, total_size_bytes FROM backup_jobs WHERE id = ?`,
  ).bind(backupJobId).first<{ state: string; manifest_sha256: string | null; total_size_bytes: number | null }>();
  if (!current || current.state !== "prepared" || current.manifest_sha256 !== input.manifest_sha256 ||
      current.total_size_bytes !== input.total_size_bytes) return false;
  const stored = await env.DB.prepare(
    `SELECT artifact_kind, size_bytes, sha256 FROM backup_artifacts
      WHERE backup_job_id = ? ORDER BY artifact_kind ASC`,
  ).bind(backupJobId).all<BackupArtifactInput>();
  if (stored.results.length !== 3) return false;
  const left = [...stored.results].sort((a, b) => a.artifact_kind.localeCompare(b.artifact_kind));
  const right = [...input.artifacts].sort((a, b) => a.artifact_kind.localeCompare(b.artifact_kind));
  return left.every((item, index) =>
    item.artifact_kind === right[index].artifact_kind &&
    item.size_bytes === right[index].size_bytes &&
    item.sha256 === right[index].sha256
  );
}

async function reportBackupResult(
  request: Request,
  env: Env,
  nodeId: string,
  backupJobId: string,
): Promise<Response> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: BackupOperationResultInput;
  try {
    input = parseBackupOperationResult(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_backup_result" }, 400);
  }

  const leaseHash = await sha256(input.lease_token);
  const now = nowIso();
  const lease = await env.DB.prepare(
    `SELECT backup_job_id, node_id, lease_expires_at
       FROM backup_operation_leases
      WHERE backup_job_id = ? AND node_id = ? AND lease_token_hash = ? AND lease_expires_at > ?`,
  ).bind(backupJobId, nodeId, leaseHash, now).first<BackupLeaseRow>();
  if (!lease) {
    if (await preparedReplayMatches(env, backupJobId, input)) {
      return json({ status: "accepted", state: "prepared", idempotent_replay: true });
    }
    return json({ error: "operation_lease_expired_or_invalid" }, 409);
  }

  const current = await env.DB.prepare(
    `SELECT state FROM backup_jobs WHERE id = ? AND node_id = ?`,
  ).bind(backupJobId, nodeId).first<{ state: string }>();
  if (!current) return json({ error: "backup_job_not_found" }, 404);

  if (input.state === "running" && current.state === "running") {
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE backup_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE backup_job_id = ?`,
    ).bind(renewedUntil, now, backupJobId).run();
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  if (input.state === "running") {
    if (current.state !== "dispatched") {
      return json({ error: "invalid_backup_transition", from_state: current.state, to_state: input.state }, 409);
    }
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE backup_jobs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND state = 'dispatched'`,
      ).bind(now, now, backupJobId),
      env.DB.prepare(
        `UPDATE backup_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE backup_job_id = ?`,
      ).bind(renewedUntil, now, backupJobId),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.running', 'dispatched', 'running', '{}', ?)`,
      ).bind(crypto.randomUUID(), backupJobId, now),
    ]);
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  if (input.state === "prepared") {
    if (current.state !== "running" || !input.artifacts || !input.manifest_sha256 || input.total_size_bytes === null) {
      return json({ error: "invalid_backup_transition", from_state: current.state, to_state: input.state }, 409);
    }
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE backup_jobs SET state = 'prepared', total_size_bytes = ?, manifest_sha256 = ?,
          prepared_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
      ).bind(input.total_size_bytes, input.manifest_sha256, now, now, backupJobId),
      env.DB.prepare(`DELETE FROM backup_operation_leases WHERE backup_job_id = ?`).bind(backupJobId),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.prepared', 'running', 'prepared', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        backupJobId,
        JSON.stringify({ manifest_sha256: input.manifest_sha256, total_size_bytes: input.total_size_bytes }),
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
         VALUES (?, 'backup.operation.prepared', 'node', ?, 'backup_job', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        nodeId,
        backupJobId,
        JSON.stringify({ manifest_sha256: input.manifest_sha256, total_size_bytes: input.total_size_bytes }),
        now,
      ),
    ];
    for (const artifact of input.artifacts) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO backup_artifacts
            (id, backup_job_id, artifact_kind, size_bytes, sha256, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(backup_job_id, artifact_kind) DO UPDATE SET
             size_bytes = excluded.size_bytes, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          backupJobId,
          artifact.artifact_kind,
          artifact.size_bytes,
          artifact.sha256,
          now,
          now,
        ),
      );
    }
    await env.DB.batch(statements);
    return json({ status: "accepted", state: "prepared" });
  }

  if (input.state === "failed") {
    if (!new Set(["dispatched", "running"]).has(current.state)) {
      return json({ error: "invalid_backup_transition", from_state: current.state, to_state: input.state }, 409);
    }
    const payload = JSON.stringify({ error_code: input.error_code });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE backup_jobs SET state = 'failed', error_code = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(input.error_code, now, now, backupJobId),
      env.DB.prepare(`DELETE FROM backup_operation_leases WHERE backup_job_id = ?`).bind(backupJobId),
      env.DB.prepare(
        `INSERT INTO backup_job_events
          (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'backup.failed', ?, 'failed', ?, ?)`,
      ).bind(crypto.randomUUID(), backupJobId, current.state, payload, now),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
         VALUES (?, 'backup.operation.failed', 'node', ?, 'backup_job', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), nodeId, backupJobId, payload, now),
    ]);
    return json({ status: "accepted", state: "failed" });
  }

  return json({ error: "invalid_backup_operation_state" }, 400);
}

export async function handleBackupOperationRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const claimMatch = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/operations\/claim$/i);
  if (request.method === "POST" && claimMatch) {
    return await claimBackupOperation(request, env, claimMatch[1]);
  }

  const resultMatch = url.pathname.match(
    /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
  );
  if (request.method === "POST" && resultMatch) {
    const exists = await env.DB.prepare(`SELECT id FROM backup_jobs WHERE id = ?`)
      .bind(resultMatch[2]).first<{ id: string }>();
    if (!exists) return null;
    return await reportBackupResult(request, env, resultMatch[1], resultMatch[2]);
  }
  return null;
}
