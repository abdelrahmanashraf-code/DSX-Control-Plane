interface Env {
  DB: D1Database;
}

type ExpirableTrial = {
  id: string;
  status: string;
  trial_state: string | null;
  trial_expires_at: string | null;
  assigned_node_id: string | null;
  database_name: string | null;
};

type ReadyProvisioning = {
  id: string;
  template_id: string;
  node_id: string | null;
};

export const TRIAL_EXPIRATION_BATCH_SIZE = 50;

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function isTrialDue(
  trial: Pick<ExpirableTrial, "status" | "trial_state" | "trial_expires_at">,
  nowMs = Date.now(),
): boolean {
  if (trial.status !== "ready" || trial.trial_state !== "active" || !trial.trial_expires_at) {
    return false;
  }
  const expiresAt = new Date(trial.trial_expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

async function markTrialExpired(env: Env, trialId: string, now: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tenants
          SET status = 'suspended', trial_state = 'expired', trial_expired_at = ?, updated_at = ?
        WHERE id = ? AND environment_kind = 'trial' AND status = 'ready' AND trial_state = 'active'`,
    ).bind(now, now, trialId),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.expired', 'system', 'trial-expiration', 'tenant', ?, '{}', ?)`,
    ).bind(crypto.randomUUID(), trialId, now),
  ]);
}

async function queueExpiredTrialCleanup(env: Env, trialId: string, now: string): Promise<boolean> {
  const tenant = await env.DB.prepare(
    `SELECT id, status, trial_state, assigned_node_id, database_name
       FROM tenants
      WHERE id = ? AND environment_kind = 'trial'`,
  ).bind(trialId).first<ExpirableTrial>();
  if (!tenant || tenant.status !== "suspended" || tenant.trial_state !== "expired") return false;
  if (!tenant.assigned_node_id || !tenant.database_name) return false;

  const existing = await env.DB.prepare(`SELECT id FROM cleanup_jobs WHERE tenant_id = ?`)
    .bind(trialId).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE tenants SET trial_state = 'cleanup_pending', updated_at = ?
        WHERE id = ? AND trial_state = 'expired'`,
    ).bind(now, trialId).run();
    return true;
  }

  const provisioned = await env.DB.prepare(
    `SELECT id, template_id, node_id
       FROM provisioning_jobs
      WHERE tenant_id = ? AND state = 'ready'
      ORDER BY finished_at DESC, created_at DESC
      LIMIT 1`,
  ).bind(trialId).first<ReadyProvisioning>();
  if (!provisioned || !provisioned.node_id || provisioned.node_id !== tenant.assigned_node_id) {
    return false;
  }

  const activeNode = await env.DB.prepare(
    `SELECT id FROM nodes
      WHERE id = ? AND lifecycle_state = 'active' AND revoked_at IS NULL`,
  ).bind(tenant.assigned_node_id).first<{ id: string }>();
  if (!activeNode) return false;

  const cleanupId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cleanup_jobs
         (id, tenant_id, provisioning_job_id, template_id, node_id, database_name,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      cleanupId,
      tenant.id,
      provisioned.id,
      provisioned.template_id,
      tenant.assigned_node_id,
      tenant.database_name,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE tenants SET trial_state = 'cleanup_pending', updated_at = ?
        WHERE id = ? AND trial_state = 'expired'`,
    ).bind(now, tenant.id),
    env.DB.prepare(
      `INSERT INTO cleanup_job_events
         (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'cleanup.queued', NULL, 'queued', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      cleanupId,
      JSON.stringify({
        database_name: tenant.database_name,
        node_id: tenant.assigned_node_id,
        reason: "trial_expired",
      }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'cleanup.job.created', 'system', 'trial-expiration', 'cleanup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      cleanupId,
      JSON.stringify({ tenant_id: tenant.id, provisioning_job_id: provisioned.id, reason: "trial_expired" }),
      now,
    ),
  ]);
  return true;
}

export async function reconcileExpiredTrials(env: Env, nowMs = Date.now()): Promise<{
  expired: number;
  cleanup_queued: number;
}> {
  const now = nowIso(nowMs);
  const due = await env.DB.prepare(
    `SELECT id, status, trial_state, trial_expires_at, assigned_node_id, database_name
       FROM tenants
      WHERE environment_kind = 'trial'
        AND status = 'ready'
        AND trial_state = 'active'
        AND trial_expires_at IS NOT NULL
        AND trial_expires_at <= ?
      ORDER BY trial_expires_at ASC
      LIMIT ?`,
  ).bind(now, TRIAL_EXPIRATION_BATCH_SIZE).all<ExpirableTrial>();

  let expired = 0;
  for (const trial of due.results) {
    if (!isTrialDue(trial, nowMs)) continue;
    await markTrialExpired(env, trial.id, now);
    expired += 1;
  }

  const awaitingCleanup = await env.DB.prepare(
    `SELECT id, status, trial_state, trial_expires_at, assigned_node_id, database_name
       FROM tenants
      WHERE environment_kind = 'trial'
        AND status = 'suspended'
        AND trial_state = 'expired'
      ORDER BY COALESCE(trial_expired_at, updated_at) ASC
      LIMIT ?`,
  ).bind(TRIAL_EXPIRATION_BATCH_SIZE).all<ExpirableTrial>();

  let cleanupQueued = 0;
  for (const trial of awaitingCleanup.results) {
    if (await queueExpiredTrialCleanup(env, trial.id, now)) cleanupQueued += 1;
  }

  return { expired, cleanup_queued: cleanupQueued };
}
