interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type JsonObject = Record<string, unknown>;

export type BackupState =
  | "queued"
  | "dispatched"
  | "running"
  | "prepared"
  | "uploaded"
  | "verified"
  | "failed";

export type BackupJobInput = {
  tenant_id: string;
  idempotency_key: string;
  backup_type: "full";
};

type TenantBackupIdentity = {
  id: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
  database_name: string | null;
};

type BackupJobRow = {
  id: string;
  tenant_id: string;
  provisioning_job_id: string;
  template_id: string;
  node_id: string;
  database_name: string;
  environment_kind: string;
  backup_type: string;
  state: BackupState;
  idempotency_key: string;
  attempt: number;
  error_code: string | null;
  total_size_bytes: number | null;
  manifest_sha256: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  prepared_at: string | null;
  uploaded_at: string | null;
  verified_at: string | null;
  finished_at: string | null;
};

type BackupArtifactRow = {
  id: string;
  backup_job_id: string;
  artifact_kind: string;
  object_key: string | null;
  object_version: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
  updated_at: string;
};

type BackupEventRow = {
  id: string;
  backup_job_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload: string;
  created_at: string;
};

const encoder = new TextEncoder();
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UUIDISH = /^[0-9a-f-]{8,64}$/i;

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

export function parseBackupJobInput(input: Record<string, unknown>): BackupJobInput {
  const tenantId = stringValue(input.tenant_id, 64);
  const idempotencyKey = stringValue(input.idempotency_key, 128);
  const backupType = stringValue(input.backup_type ?? "full", 32).toLowerCase();

  if (!UUIDISH.test(tenantId)) throw new Error("invalid_tenant_id");
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error("invalid_idempotency_key");
  if (backupType !== "full") throw new Error("unsupported_backup_type");

  return {
    tenant_id: tenantId,
    idempotency_key: idempotencyKey,
    backup_type: "full",
  };
}

export function backupEligibility(input: TenantBackupIdentity): string | null {
  if (input.environment_kind !== "test") return "backup_non_test_environment_blocked";
  if (input.status !== "ready") return "tenant_not_backup_ready";
  if (!input.assigned_node_id) return "backup_node_missing";
  if (!input.database_name) return "backup_database_missing";
  return null;
}

async function getBackupJob(env: Env, id: string): Promise<BackupJobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
            environment_kind, backup_type, state, idempotency_key, attempt, error_code,
            total_size_bytes, manifest_sha256, created_at, updated_at, started_at,
            prepared_at, uploaded_at, verified_at, finished_at
       FROM backup_jobs
      WHERE id = ?`,
  ).bind(id).first<BackupJobRow>();
}

async function createBackupJob(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: BackupJobInput;
  try {
    input = parseBackupJobInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_backup_job" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
            environment_kind, backup_type, state, idempotency_key, attempt, error_code,
            total_size_bytes, manifest_sha256, created_at, updated_at, started_at,
            prepared_at, uploaded_at, verified_at, finished_at
       FROM backup_jobs
      WHERE tenant_id = ? AND idempotency_key = ?`,
  ).bind(input.tenant_id, input.idempotency_key).first<BackupJobRow>();
  if (existing) return json({ backup_job: existing, idempotent_replay: true });

  const tenant = await env.DB.prepare(
    `SELECT id, environment_kind, status, assigned_node_id, database_name
       FROM tenants
      WHERE id = ?`,
  ).bind(input.tenant_id).first<TenantBackupIdentity>();
  if (!tenant) return json({ error: "tenant_not_found" }, 404);

  const eligibilityError = backupEligibility(tenant);
  if (eligibilityError) return json({ error: eligibilityError }, 409);

  const provisioned = await env.DB.prepare(
    `SELECT id, template_id, node_id
       FROM provisioning_jobs
      WHERE tenant_id = ? AND state = 'ready'
      ORDER BY finished_at DESC, created_at DESC
      LIMIT 1`,
  ).bind(tenant.id).first<{ id: string; template_id: string; node_id: string | null }>();
  if (!provisioned || !provisioned.node_id || provisioned.node_id !== tenant.assigned_node_id) {
    return json({ error: "backup_provisioning_identity_missing" }, 409);
  }

  const activeNode = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL`,
  ).bind(tenant.assigned_node_id).first<{ id: string }>();
  if (!activeNode) return json({ error: "backup_node_unavailable" }, 409);

  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO backup_jobs
         (id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
          environment_kind, backup_type, state, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).bind(
      id,
      tenant.id,
      provisioned.id,
      provisioned.template_id,
      tenant.assigned_node_id,
      tenant.database_name,
      tenant.environment_kind,
      input.backup_type,
      input.idempotency_key,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO backup_job_events
         (id, backup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'backup.queued', NULL, 'queued', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({
        tenant_id: tenant.id,
        node_id: tenant.assigned_node_id,
        database_name: tenant.database_name,
        backup_type: input.backup_type,
      }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'backup.job.created', 'admin', 'admin-api', 'backup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({
        tenant_id: tenant.id,
        provisioning_job_id: provisioned.id,
        node_id: tenant.assigned_node_id,
        backup_type: input.backup_type,
      }),
      now,
    ),
  ]);

  return json({ backup_job: await getBackupJob(env, id), idempotent_replay: false }, 201);
}

async function listBackupJobs(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `SELECT id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
            environment_kind, backup_type, state, idempotency_key, attempt, error_code,
            total_size_bytes, manifest_sha256, created_at, updated_at, started_at,
            prepared_at, uploaded_at, verified_at, finished_at
       FROM backup_jobs
      ORDER BY created_at DESC
      LIMIT 500`,
  ).all<BackupJobRow>();
  return json({ backup_jobs: result.results });
}

async function readBackupJob(request: Request, env: Env, backupJobId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const backupJob = await getBackupJob(env, backupJobId);
  if (!backupJob) return json({ error: "backup_job_not_found" }, 404);

  const [events, artifacts] = await Promise.all([
    env.DB.prepare(
      `SELECT id, backup_job_id, event_type, from_state, to_state, payload, created_at
         FROM backup_job_events
        WHERE backup_job_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 500`,
    ).bind(backupJobId).all<BackupEventRow>(),
    env.DB.prepare(
      `SELECT id, backup_job_id, artifact_kind, object_key, object_version, size_bytes,
              sha256, created_at, updated_at
         FROM backup_artifacts
        WHERE backup_job_id = ?
        ORDER BY artifact_kind ASC`,
    ).bind(backupJobId).all<BackupArtifactRow>(),
  ]);

  return json({
    backup_job: backupJob,
    events: events.results,
    artifacts: artifacts.results,
  });
}

export async function handleBackupAdminRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/v1/admin/backup-jobs") {
    if (request.method === "POST") return await createBackupJob(request, env);
    if (request.method === "GET") return await listBackupJobs(request, env);
  }

  const readMatch = url.pathname.match(/^\/v1\/admin\/backup-jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && readMatch) {
    return await readBackupJob(request, env, readMatch[1]);
  }

  return null;
}
