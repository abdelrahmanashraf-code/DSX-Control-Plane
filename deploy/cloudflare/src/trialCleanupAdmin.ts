interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type FailedTrialCleanup = {
  id: string;
  tenant_id: string;
  node_id: string;
  database_name: string;
  state: string;
  error_code: string | null;
  tenant_status: string;
  trial_state: string | null;
  assigned_node_id: string | null;
  tenant_database_name: string | null;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

export function trialCleanupRetryEligibility(job: FailedTrialCleanup): string | null {
  if (job.state !== "failed") return "trial_cleanup_retry_requires_failed_job";
  if (job.tenant_status !== "failed" || job.trial_state !== "failed") {
    return "trial_cleanup_retry_tenant_not_failed";
  }
  if (!job.assigned_node_id || job.assigned_node_id !== job.node_id) {
    return "trial_cleanup_retry_node_mismatch";
  }
  if (!job.tenant_database_name || job.tenant_database_name !== job.database_name) {
    return "trial_cleanup_retry_database_mismatch";
  }
  return null;
}

async function retryTrialCleanup(request: Request, env: Env, tenantId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const job = await env.DB.prepare(
    `SELECT j.id, j.tenant_id, j.node_id, j.database_name, j.state, j.error_code,
            t.status AS tenant_status, t.trial_state, t.assigned_node_id,
            t.database_name AS tenant_database_name
       FROM cleanup_jobs j
       JOIN tenants t ON t.id = j.tenant_id
      WHERE j.tenant_id = ? AND t.environment_kind = 'trial'
      ORDER BY j.created_at DESC
      LIMIT 1`,
  ).bind(tenantId).first<FailedTrialCleanup>();
  if (!job) return json({ error: "trial_cleanup_job_not_found" }, 404);

  const eligibilityError = trialCleanupRetryEligibility(job);
  if (eligibilityError) return json({ error: eligibilityError }, 409);

  const activeNode = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL`,
  ).bind(job.node_id).first<{ id: string }>();
  if (!activeNode) return json({ error: "trial_cleanup_node_unavailable" }, 409);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM cleanup_operation_leases WHERE cleanup_job_id = ?`).bind(job.id),
    env.DB.prepare(
      `UPDATE cleanup_jobs
          SET state = 'queued', error_code = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'failed'`,
    ).bind(now, job.id),
    env.DB.prepare(
      `UPDATE tenants SET status = 'suspended', trial_state = 'cleanup_pending', updated_at = ?
        WHERE id = ? AND environment_kind = 'trial' AND status = 'failed' AND trial_state = 'failed'`,
    ).bind(now, tenantId),
    env.DB.prepare(
      `INSERT INTO cleanup_job_events
        (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'cleanup.retry_queued', 'failed', 'queued', ?, ?)`,
    ).bind(crypto.randomUUID(), job.id, JSON.stringify({ previous_error_code: job.error_code, reason: "trial_expired" }), now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.cleanup.retry_queued', 'admin', 'admin-api', 'cleanup_job', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), job.id, JSON.stringify({ tenant_id: tenantId, previous_error_code: job.error_code }), now),
  ]);

  return json({ cleanup_job_id: job.id, tenant_id: tenantId, state: "queued", retried: true });
}

export async function handleTrialCleanupAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const retryMatch = url.pathname.match(/^\/v1\/admin\/trials\/([0-9a-f-]+)\/cleanup\/retry$/i);
  if (request.method === "POST" && retryMatch) {
    return await retryTrialCleanup(request, env, retryMatch[1]);
  }
  return null;
}
