interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type JobRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  node_id: string | null;
  pool: string;
  state: string;
  idempotency_key: string;
  attempt: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
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

export function retryMode(state: string): "transition" | "replay" | "reject" {
  if (state === "failed") return "transition";
  if (state === "retrying") return "replay";
  return "reject";
}

async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
            error_code, created_at, updated_at, started_at, finished_at
       FROM provisioning_jobs
      WHERE id = ?`,
  ).bind(jobId).first<JobRow>();
}

export async function handleProvisioningRetryRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/v1\/admin\/provisioning-jobs\/([0-9a-f-]+)\/retry$/i,
  );
  if (!match || request.method !== "POST") return null;
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const jobId = match[1];
  const job = await getJob(env, jobId);
  if (!job) return json({ error: "provisioning_job_not_found" }, 404);

  const mode = retryMode(job.state);
  if (mode === "replay") return json({ job, retry_replay: true });
  if (mode === "reject") {
    return json({ error: "provisioning_job_not_retryable", state: job.state }, 409);
  }
  if (!job.node_id) return json({ error: "provisioning_retry_node_missing" }, 409);

  const activeNode = await env.DB.prepare(
    `SELECT id
       FROM nodes
      WHERE id = ?
        AND lifecycle_state = 'active'
        AND revoked_at IS NULL`,
  ).bind(job.node_id).first<{ id: string }>();
  if (!activeNode) return json({ error: "provisioning_retry_node_unavailable" }, 409);

  const now = nowIso();
  const eventPayload = JSON.stringify({ reason: "admin_retry" });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM provisioning_operation_leases WHERE job_id = ?`).bind(job.id),
    env.DB.prepare(
      `UPDATE provisioning_jobs
          SET state = 'retrying', error_code = NULL, updated_at = ?,
              started_at = NULL, finished_at = NULL
        WHERE id = ? AND state = 'failed'`,
    ).bind(now, job.id),
    env.DB.prepare(
      `UPDATE tenants
          SET status = 'provisioning', assigned_node_id = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(job.node_id, now, job.tenant_id),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
         (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'provisioning.retrying', 'failed', 'retrying', ?, ?)`,
    ).bind(crypto.randomUUID(), job.id, eventPayload, now),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'provisioning.job.retry_requested', 'admin', 'admin-api',
               'provisioning_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      job.id,
      JSON.stringify({ node_id: job.node_id, previous_error_code: job.error_code }),
      now,
    ),
  ]);

  const retried = await getJob(env, job.id);
  return json({ job: retried, retry_replay: false });
}
