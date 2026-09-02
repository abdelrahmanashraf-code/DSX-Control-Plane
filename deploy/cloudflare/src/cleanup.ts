interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type CleanupJobRow = {
  id: string;
  tenant_id: string;
  provisioning_job_id: string;
  template_id: string;
  node_id: string;
  database_name: string;
  state: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type TenantRow = {
  id: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
  database_name: string | null;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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

async function getCleanupJob(env: Env, id: string): Promise<CleanupJobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
            state, error_code, created_at, updated_at, started_at, finished_at
       FROM cleanup_jobs
      WHERE id = ?`,
  ).bind(id).first<CleanupJobRow>();
}

export function cleanupEligibility(input: TenantRow): string | null {
  if (input.environment_kind !== "test") return "cleanup_non_test_environment_blocked";
  if (input.status !== "ready") return "tenant_not_cleanup_ready";
  if (!input.assigned_node_id) return "cleanup_node_missing";
  if (!input.database_name) return "cleanup_database_missing";
  return null;
}

async function requestCleanup(request: Request, env: Env, tenantId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const existing = await env.DB.prepare(
    `SELECT id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
            state, error_code, created_at, updated_at, started_at, finished_at
       FROM cleanup_jobs
      WHERE tenant_id = ?`,
  ).bind(tenantId).first<CleanupJobRow>();
  if (existing) return json({ cleanup_job: existing, idempotent_replay: true });

  const tenant = await env.DB.prepare(
    `SELECT id, environment_kind, status, assigned_node_id, database_name
       FROM tenants
      WHERE id = ?`,
  ).bind(tenantId).first<TenantRow>();
  if (!tenant) return json({ error: "tenant_not_found" }, 404);

  const eligibilityError = cleanupEligibility(tenant);
  if (eligibilityError) return json({ error: eligibilityError }, 409);

  const provisioned = await env.DB.prepare(
    `SELECT id, template_id, node_id
       FROM provisioning_jobs
      WHERE tenant_id = ? AND state = 'ready'
      ORDER BY finished_at DESC, created_at DESC
      LIMIT 1`,
  ).bind(tenantId).first<{ id: string; template_id: string; node_id: string | null }>();
  if (!provisioned || !provisioned.node_id || provisioned.node_id !== tenant.assigned_node_id) {
    return json({ error: "cleanup_provisioning_identity_missing" }, 409);
  }

  const activeNode = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL`,
  ).bind(tenant.assigned_node_id).first<{ id: string }>();
  if (!activeNode) return json({ error: "cleanup_node_unavailable" }, 409);

  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cleanup_jobs
         (id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      id,
      tenant.id,
      provisioned.id,
      provisioned.template_id,
      tenant.assigned_node_id,
      tenant.database_name,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ? AND status = 'ready'`,
    ).bind(now, tenant.id),
    env.DB.prepare(
      `INSERT INTO cleanup_job_events
         (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'cleanup.queued', NULL, 'queued', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({ database_name: tenant.database_name, node_id: tenant.assigned_node_id }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'cleanup.job.created', 'admin', 'admin-api', 'cleanup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({ tenant_id: tenant.id, provisioning_job_id: provisioned.id }),
      now,
    ),
  ]);

  return json({ cleanup_job: await getCleanupJob(env, id), idempotent_replay: false }, 201);
}

async function readCleanupJob(request: Request, env: Env, cleanupJobId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const cleanupJob = await getCleanupJob(env, cleanupJobId);
  if (!cleanupJob) return json({ error: "cleanup_job_not_found" }, 404);
  const events = await env.DB.prepare(
    `SELECT id, cleanup_job_id, event_type, from_state, to_state, payload, created_at
       FROM cleanup_job_events
      WHERE cleanup_job_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
  ).bind(cleanupJobId).all<Record<string, unknown>>();
  return json({ cleanup_job: cleanupJob, events: events.results });
}

export async function handleCleanupAdminRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const requestMatch = url.pathname.match(/^\/v1\/admin\/tenants\/([0-9a-f-]+)\/cleanup$/i);
  if (request.method === "POST" && requestMatch) {
    return await requestCleanup(request, env, requestMatch[1]);
  }

  const readMatch = url.pathname.match(/^\/v1\/admin\/cleanup-jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && readMatch) {
    return await readCleanupJob(request, env, readMatch[1]);
  }
  return null;
}
