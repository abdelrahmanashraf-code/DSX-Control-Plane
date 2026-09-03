interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type JsonObject = Record<string, unknown>;

export type RestoreState =
  | "queued"
  | "dispatched"
  | "running"
  | "restored"
  | "validated"
  | "failed";

export type RestoreJobInput = {
  backup_job_id: string;
  target_tenant_id: string;
  idempotency_key: string;
};

type BackupRestoreIdentity = {
  id: string;
  source_tenant_id: string;
  template_id: string;
  node_id: string;
  source_database_name: string;
  environment_kind: string;
  backup_type: string;
  state: string;
  sector: string;
  database_prefix: string;
};

type TargetTenantIdentity = {
  id: string;
  slug: string;
  sector: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
  database_name: string | null;
};

type RestoreJobRow = {
  id: string;
  backup_job_id: string;
  source_tenant_id: string;
  target_tenant_id: string;
  template_id: string;
  node_id: string;
  source_database_name: string;
  target_database_name: string;
  environment_kind: string;
  state: RestoreState;
  idempotency_key: string;
  attempt: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  restored_at: string | null;
  validated_at: string | null;
  finished_at: string | null;
};

type RestoreEventRow = {
  id: string;
  restore_job_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload: string;
  created_at: string;
};

type BackupArtifactRow = {
  artifact_kind: string;
  object_key: string | null;
  object_version: string | null;
  size_bytes: number | null;
  sha256: string | null;
};

const encoder = new TextEncoder();
const UUIDISH = /^[0-9a-f-]{8,64}$/i;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{2,62}$/;
const REQUIRED_ARTIFACTS = new Set(["database_dump", "filestore_archive", "manifest"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request: Request): Promise<JsonObject | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
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

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const supplied = bearerToken(request);
  if (!supplied || !env.ADMIN_API_TOKEN) return false;
  return (await sha256(supplied)) === (await sha256(env.ADMIN_API_TOKEN));
}

function nowIso(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parseRestoreJobInput(input: Record<string, unknown>): RestoreJobInput {
  const backupJobId = stringValue(input.backup_job_id, 64);
  const targetTenantId = stringValue(input.target_tenant_id, 64);
  const idempotencyKey = stringValue(input.idempotency_key, 128);

  if (!UUIDISH.test(backupJobId)) throw new Error("invalid_backup_job_id");
  if (!UUIDISH.test(targetTenantId)) throw new Error("invalid_target_tenant_id");
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error("invalid_idempotency_key");

  return {
    backup_job_id: backupJobId,
    target_tenant_id: targetTenantId,
    idempotency_key: idempotencyKey,
  };
}

export function restoreEligibility(
  backup: Pick<BackupRestoreIdentity, "state" | "environment_kind" | "backup_type" | "source_tenant_id" | "sector">,
  target: TargetTenantIdentity,
): string | null {
  if (backup.state !== "verified") return "restore_backup_not_verified";
  if (backup.environment_kind !== "test" || target.environment_kind !== "test") {
    return "restore_non_test_environment_blocked";
  }
  if (backup.backup_type !== "full") return "restore_backup_type_unsupported";
  if (backup.source_tenant_id === target.id) return "restore_target_must_be_disposable";
  if (target.status !== "pending") return "restore_target_not_pending";
  if (target.assigned_node_id || target.database_name) return "restore_target_identity_not_empty";
  if (target.sector !== backup.sector) return "restore_sector_mismatch";
  return null;
}

export function deterministicRestoreDatabaseName(
  databasePrefix: string,
  targetSlug: string,
  targetTenantId: string,
): string {
  const prefix = databasePrefix.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const slug = targetSlug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const suffix = targetTenantId.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 8);
  const tail = `_restore_${slug}_${suffix}`;
  const headBudget = 63 - tail.length;
  const head = prefix.slice(0, Math.max(1, headBudget)).replace(/_+$/g, "") || "d";
  const value = `${head}${tail}`.slice(0, 63);
  if (!SAFE_DATABASE.test(value)) throw new Error("invalid_restore_database_name");
  return value;
}

export function backupArtifactsComplete(artifacts: BackupArtifactRow[]): boolean {
  if (artifacts.length !== 3) return false;
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (!REQUIRED_ARTIFACTS.has(artifact.artifact_kind) || seen.has(artifact.artifact_kind)) return false;
    if (!artifact.object_key || !artifact.object_version) return false;
    if (artifact.size_bytes === null || artifact.size_bytes < 0) return false;
    if (!artifact.sha256 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) return false;
    seen.add(artifact.artifact_kind);
  }
  return seen.size === REQUIRED_ARTIFACTS.size;
}

async function getRestoreJob(env: Env, id: string): Promise<RestoreJobRow | null> {
  return await env.DB.prepare(
    `SELECT id, backup_job_id, source_tenant_id, target_tenant_id, template_id, node_id,
            source_database_name, target_database_name, environment_kind, state,
            idempotency_key, attempt, error_code, created_at, updated_at, started_at,
            restored_at, validated_at, finished_at
       FROM restore_jobs
      WHERE id = ?`,
  ).bind(id).first<RestoreJobRow>();
}

async function createRestoreJob(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: RestoreJobInput;
  try {
    input = parseRestoreJobInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_restore_job" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id, backup_job_id, source_tenant_id, target_tenant_id, template_id, node_id,
            source_database_name, target_database_name, environment_kind, state,
            idempotency_key, attempt, error_code, created_at, updated_at, started_at,
            restored_at, validated_at, finished_at
       FROM restore_jobs
      WHERE target_tenant_id = ? AND idempotency_key = ?`,
  ).bind(input.target_tenant_id, input.idempotency_key).first<RestoreJobRow>();
  if (existing) return json({ restore_job: existing, idempotent_replay: true });

  const backup = await env.DB.prepare(
    `SELECT b.id,
            b.tenant_id AS source_tenant_id,
            b.template_id,
            b.node_id,
            b.database_name AS source_database_name,
            b.environment_kind,
            b.backup_type,
            b.state,
            t.sector,
            pt.database_prefix
       FROM backup_jobs b
       JOIN tenants t ON t.id = b.tenant_id
       JOIN provisioning_templates pt ON pt.id = b.template_id
      WHERE b.id = ?`,
  ).bind(input.backup_job_id).first<BackupRestoreIdentity>();
  if (!backup) return json({ error: "restore_backup_not_found" }, 404);

  const target = await env.DB.prepare(
    `SELECT id, slug, sector, environment_kind, status, assigned_node_id, database_name
       FROM tenants
      WHERE id = ?`,
  ).bind(input.target_tenant_id).first<TargetTenantIdentity>();
  if (!target) return json({ error: "restore_target_tenant_not_found" }, 404);

  const eligibilityError = restoreEligibility(backup, target);
  if (eligibilityError) return json({ error: eligibilityError }, 409);

  const artifacts = await env.DB.prepare(
    `SELECT artifact_kind, object_key, object_version, size_bytes, sha256
       FROM backup_artifacts
      WHERE backup_job_id = ?
      ORDER BY artifact_kind ASC`,
  ).bind(backup.id).all<BackupArtifactRow>();
  if (!backupArtifactsComplete(artifacts.results)) {
    return json({ error: "restore_backup_artifacts_incomplete" }, 409);
  }

  const activeNode = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL`,
  ).bind(backup.node_id).first<{ id: string }>();
  if (!activeNode) return json({ error: "restore_node_unavailable" }, 409);

  let targetDatabaseName: string;
  try {
    targetDatabaseName = deterministicRestoreDatabaseName(
      backup.database_prefix,
      target.slug,
      target.id,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_restore_database_name" }, 409);
  }
  if (targetDatabaseName === backup.source_database_name) {
    return json({ error: "restore_target_database_conflict" }, 409);
  }

  const jobId = crypto.randomUUID();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO restore_jobs
         (id, backup_job_id, source_tenant_id, target_tenant_id, template_id, node_id,
          source_database_name, target_database_name, environment_kind, state,
          idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 'queued', ?, ?, ?)`,
    ).bind(
      jobId,
      backup.id,
      backup.source_tenant_id,
      target.id,
      backup.template_id,
      backup.node_id,
      backup.source_database_name,
      targetDatabaseName,
      input.idempotency_key,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO restore_job_events
         (id, restore_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'restore.queued', NULL, 'queued', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      jobId,
      JSON.stringify({
        backup_job_id: backup.id,
        target_tenant_id: target.id,
        node_id: backup.node_id,
        target_database_name: targetDatabaseName,
      }),
      now,
    ),
    env.DB.prepare(
      `UPDATE tenants
          SET status = 'provisioning', assigned_node_id = ?, database_name = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND assigned_node_id IS NULL AND database_name IS NULL`,
    ).bind(backup.node_id, targetDatabaseName, now, target.id),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'restore.job.created', 'admin', 'admin-api', 'restore_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      jobId,
      JSON.stringify({
        backup_job_id: backup.id,
        source_tenant_id: backup.source_tenant_id,
        target_tenant_id: target.id,
        node_id: backup.node_id,
        target_database_name: targetDatabaseName,
      }),
      now,
    ),
  ]);

  return json({ restore_job: await getRestoreJob(env, jobId), idempotent_replay: false }, 201);
}

async function listRestoreJobs(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `SELECT id, backup_job_id, source_tenant_id, target_tenant_id, template_id, node_id,
            source_database_name, target_database_name, environment_kind, state,
            idempotency_key, attempt, error_code, created_at, updated_at, started_at,
            restored_at, validated_at, finished_at
       FROM restore_jobs
      ORDER BY created_at DESC
      LIMIT 500`,
  ).all<RestoreJobRow>();
  return json({ restore_jobs: result.results });
}

async function readRestoreJob(request: Request, env: Env, restoreJobId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const restoreJob = await getRestoreJob(env, restoreJobId);
  if (!restoreJob) return json({ error: "restore_job_not_found" }, 404);

  const events = await env.DB.prepare(
    `SELECT id, restore_job_id, event_type, from_state, to_state, payload, created_at
       FROM restore_job_events
      WHERE restore_job_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 500`,
  ).bind(restoreJobId).all<RestoreEventRow>();

  return json({ restore_job: restoreJob, events: events.results });
}

export async function handleRestoreAdminRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/v1/admin/restore-jobs") {
    if (request.method === "POST") return await createRestoreJob(request, env);
    if (request.method === "GET") return await listRestoreJobs(request, env);
  }

  const readMatch = url.pathname.match(/^\/v1\/admin\/restore-jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && readMatch) {
    return await readRestoreJob(request, env, readMatch[1]);
  }

  return null;
}
