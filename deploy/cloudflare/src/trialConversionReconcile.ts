interface Env {
  DB: D1Database;
}

type LinkedConversionJobRow = {
  job_id: string;
  job_state: string;
  job_error_code: string | null;
  job_started_at: string | null;
  job_finished_at: string | null;
  conversion_id: string;
  conversion_state: string;
  target_tenant_id: string;
};

export type ConversionProvisioningState = "provisioning" | "ready" | "failed";

export function conversionStateForProvisioningState(jobState: string): ConversionProvisioningState | null {
  if (new Set(["placed", "dispatched", "running", "retrying"]).has(jobState)) return "provisioning";
  if (jobState === "ready") return "ready";
  if (jobState === "failed") return "failed";
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getLinkedConversionJob(env: Env, jobId: string): Promise<LinkedConversionJobRow | null> {
  return await env.DB.prepare(
    `SELECT j.id AS job_id,
            j.state AS job_state,
            j.error_code AS job_error_code,
            j.started_at AS job_started_at,
            j.finished_at AS job_finished_at,
            c.id AS conversion_id,
            c.state AS conversion_state,
            c.target_tenant_id
       FROM provisioning_jobs j
       JOIN tenants t
         ON t.id = j.tenant_id
        AND t.environment_kind = 'production'
       JOIN trial_conversion_requests c
         ON c.target_tenant_id = t.id
        AND c.mode = 'clean_production'
        AND j.idempotency_key = ('conversion:' || c.id)
      WHERE j.id = ?
      LIMIT 1`,
  ).bind(jobId).first<LinkedConversionJobRow>();
}

export async function reconcileTrialConversionForProvisioningJob(
  env: Env,
  jobId: string,
): Promise<boolean> {
  const row = await getLinkedConversionJob(env, jobId);
  if (!row) return false;

  const targetState = conversionStateForProvisioningState(row.job_state);
  if (!targetState || row.conversion_state === targetState) return false;
  if (!new Set(["approved", "provisioning"]).has(row.conversion_state)) return false;

  const now = nowIso();
  const terminal = targetState === "ready" || targetState === "failed";
  const errorCode = targetState === "failed"
    ? row.job_error_code || "production_provisioning_failed"
    : null;
  const startedAt = row.job_started_at || now;
  const finishedAt = terminal ? row.job_finished_at || now : null;

  const updated = await env.DB.prepare(
    `UPDATE trial_conversion_requests
        SET state = ?,
            error_code = ?,
            started_at = COALESCE(started_at, ?),
            finished_at = ?,
            updated_at = ?
      WHERE id = ?
        AND target_tenant_id = ?
        AND state IN ('approved', 'provisioning')
      RETURNING id`,
  ).bind(
    targetState,
    errorCode,
    startedAt,
    finishedAt,
    now,
    row.conversion_id,
    row.target_tenant_id,
  ).first<{ id: string }>();

  if (!updated) return false;

  const payload = JSON.stringify({
    provisioning_job_id: row.job_id,
    provisioning_state: row.job_state,
    conversion_state: targetState,
    target_tenant_id: row.target_tenant_id,
    error_code: errorCode,
  });

  await env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
     VALUES (?, 'trial.conversion.provisioning_reconciled', 'system', NULL,
             'trial_conversion', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), row.conversion_id, payload, now).run();

  return true;
}

export async function reconcileActiveTrialConversions(env: Env, limit = 50): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit || 50)));
  const jobs = await env.DB.prepare(
    `SELECT j.id
       FROM provisioning_jobs j
       JOIN tenants t
         ON t.id = j.tenant_id
        AND t.environment_kind = 'production'
       JOIN trial_conversion_requests c
         ON c.target_tenant_id = t.id
        AND c.mode = 'clean_production'
        AND j.idempotency_key = ('conversion:' || c.id)
      WHERE c.state IN ('approved', 'provisioning')
        AND j.state IN ('placed', 'dispatched', 'running', 'retrying', 'ready', 'failed')
      ORDER BY j.updated_at ASC
      LIMIT ?`,
  ).bind(boundedLimit).all<{ id: string }>();

  let changed = 0;
  for (const row of jobs.results) {
    if (await reconcileTrialConversionForProvisioningJob(env, row.id)) changed += 1;
  }
  return changed;
}
