interface Env {
  DB: D1Database;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

type CleanupClaimRow = { cleanup_job_id: string };
type CleanupSourceRow = {
  cleanup_job_id: string;
  tenant_id: string;
  provisioning_job_id: string;
  template_id: string;
  node_id: string;
  database_name: string;
  environment_kind: string;
  state: string;
};
type CleanupLeaseRow = {
  cleanup_job_id: string;
  node_id: string;
  lease_expires_at: string;
};

export type CleanupOperationResultInput = {
  lease_token: string;
  state: "running" | "cleaned" | "failed";
  error_code: string | null;
};

const encoder = new TextEncoder();
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

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

export function buildCleanupOperationPayload(source: CleanupSourceRow): Record<string, unknown> {
  return {
    tenant_id: source.tenant_id,
    environment_kind: source.environment_kind,
    template_id: source.template_id,
    provisioning_operation_id: source.provisioning_job_id,
    database_name: source.database_name,
  };
}

export function parseCleanupOperationResult(input: Record<string, unknown>): CleanupOperationResultInput {
  const leaseToken = typeof input.lease_token === "string" ? input.lease_token.trim().slice(0, 256) : "";
  const state = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  const errorCode = typeof input.error_code === "string"
    ? input.error_code.trim().toLowerCase().slice(0, 120)
    : null;

  if (leaseToken.length < 16) throw new Error("invalid_lease_token");
  if (!new Set(["running", "cleaned", "failed"]).has(state)) {
    throw new Error("invalid_cleanup_operation_state");
  }
  if (errorCode !== null && !SAFE_CODE.test(errorCode)) throw new Error("invalid_error_code");

  return {
    lease_token: leaseToken,
    state: state as CleanupOperationResultInput["state"],
    error_code: state === "failed" ? errorCode || "cleanup_failed" : null,
  };
}

async function markExpiredCleanupLeases(env: Env, nodeId: string): Promise<void> {
  const now = nowIso();
  const expired = await env.DB.prepare(
    `SELECT l.cleanup_job_id
       FROM cleanup_operation_leases l
       JOIN cleanup_jobs j ON j.id = l.cleanup_job_id
      WHERE l.node_id = ? AND l.lease_expires_at <= ?
        AND j.state IN ('dispatched', 'running')
      ORDER BY l.lease_expires_at ASC
      LIMIT 20`,
  ).bind(nodeId, now).all<{ cleanup_job_id: string }>();

  for (const row of expired.results) {
    const current = await env.DB.prepare(
      `SELECT tenant_id, state FROM cleanup_jobs WHERE id = ?`,
    ).bind(row.cleanup_job_id).first<{ tenant_id: string; state: string }>();
    if (!current) continue;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE cleanup_jobs SET state = 'failed', error_code = 'operation_lease_expired',
          updated_at = ?, finished_at = ? WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(now, now, row.cleanup_job_id),
      env.DB.prepare(`UPDATE tenants SET status = 'failed', updated_at = ? WHERE id = ?`).bind(now, current.tenant_id),
      env.DB.prepare(`DELETE FROM cleanup_operation_leases WHERE cleanup_job_id = ?`).bind(row.cleanup_job_id),
      env.DB.prepare(
        `INSERT INTO cleanup_job_events
          (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'cleanup.failed', ?, 'failed', '{"error_code":"operation_lease_expired"}', ?)`,
      ).bind(crypto.randomUUID(), row.cleanup_job_id, current.state, now),
    ]);
  }
}

async function claimCleanupOperation(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response | null> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }

  await markExpiredCleanupLeases(env, nodeId);
  const leaseToken = randomSecret("dsx_cleanup_lease");
  const leaseHash = await sha256(leaseToken);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();

  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO cleanup_operation_leases
       (cleanup_job_id, node_id, lease_token_hash, lease_expires_at, created_at, updated_at)
     SELECT j.id, j.node_id, ?, ?, ?, ?
       FROM cleanup_jobs j
      WHERE j.node_id = ? AND j.state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM cleanup_operation_leases existing WHERE existing.cleanup_job_id = j.id
        )
      ORDER BY j.created_at ASC
      LIMIT 1
     RETURNING cleanup_job_id`,
  ).bind(leaseHash, expiresAt, now, now, nodeId).first<CleanupClaimRow>();

  if (!claimed) return null;

  const source = await env.DB.prepare(
    `SELECT j.id AS cleanup_job_id, j.tenant_id, j.provisioning_job_id, j.template_id,
            j.node_id, j.database_name, j.state, t.environment_kind
       FROM cleanup_jobs j
       JOIN tenants t ON t.id = j.tenant_id
      WHERE j.id = ? AND j.node_id = ?`,
  ).bind(claimed.cleanup_job_id, nodeId).first<CleanupSourceRow>();

  if (!source || source.state !== "queued" || source.environment_kind !== "test") {
    await env.DB.prepare(`DELETE FROM cleanup_operation_leases WHERE cleanup_job_id = ?`)
      .bind(claimed.cleanup_job_id).run();
    return json({ error: "cleanup_operation_claim_conflict" }, 409);
  }

  const payload = buildCleanupOperationPayload(source);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE cleanup_jobs SET state = 'dispatched', error_code = NULL, updated_at = ?
        WHERE id = ? AND state = 'queued'`,
    ).bind(now, source.cleanup_job_id),
    env.DB.prepare(
      `INSERT INTO cleanup_job_events
        (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'cleanup.dispatched', 'queued', 'dispatched', ?, ?)`,
    ).bind(crypto.randomUUID(), source.cleanup_job_id, JSON.stringify({ node_id: nodeId }), now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'cleanup.operation.claimed', 'node', ?, 'cleanup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      nodeId,
      source.cleanup_job_id,
      JSON.stringify({ operation_type: "cleanup_test_odoo_environment" }),
      now,
    ),
  ]);

  return json({
    operation: {
      id: source.cleanup_job_id,
      type: "cleanup_test_odoo_environment",
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      payload,
    },
  });
}

async function reportCleanupResult(
  request: Request,
  env: Env,
  nodeId: string,
  cleanupJobId: string,
): Promise<Response> {
  if (!(await authenticateNode(request, env, nodeId))) {
    return json({ error: "invalid_or_revoked_agent" }, 401);
  }
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: CleanupOperationResultInput;
  try {
    input = parseCleanupOperationResult(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_cleanup_result" }, 400);
  }

  const leaseHash = await sha256(input.lease_token);
  const now = nowIso();
  const lease = await env.DB.prepare(
    `SELECT cleanup_job_id, node_id, lease_expires_at
       FROM cleanup_operation_leases
      WHERE cleanup_job_id = ? AND node_id = ? AND lease_token_hash = ? AND lease_expires_at > ?`,
  ).bind(cleanupJobId, nodeId, leaseHash, now).first<CleanupLeaseRow>();
  if (!lease) return json({ error: "operation_lease_expired_or_invalid" }, 409);

  const current = await env.DB.prepare(
    `SELECT tenant_id, state FROM cleanup_jobs WHERE id = ? AND node_id = ?`,
  ).bind(cleanupJobId, nodeId).first<{ tenant_id: string; state: string }>();
  if (!current) return json({ error: "cleanup_job_not_found" }, 404);

  if (input.state === "running" && current.state === "running") {
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE cleanup_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE cleanup_job_id = ?`,
    ).bind(renewedUntil, now, cleanupJobId).run();
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  if (input.state === "running") {
    if (current.state !== "dispatched") {
      return json({ error: "invalid_cleanup_transition", from_state: current.state, to_state: input.state }, 409);
    }
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE cleanup_jobs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
      ).bind(now, now, cleanupJobId),
      env.DB.prepare(
        `UPDATE cleanup_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE cleanup_job_id = ?`,
      ).bind(renewedUntil, now, cleanupJobId),
      env.DB.prepare(
        `INSERT INTO cleanup_job_events
          (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'cleanup.running', 'dispatched', 'running', '{}', ?)`,
      ).bind(crypto.randomUUID(), cleanupJobId, now),
    ]);
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  if (current.state !== "running") {
    return json({ error: "invalid_cleanup_transition", from_state: current.state, to_state: input.state }, 409);
  }

  const terminalPayload = input.state === "cleaned"
    ? "{}"
    : JSON.stringify({ error_code: input.error_code });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE cleanup_jobs SET state = ?, error_code = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
    ).bind(input.state, input.error_code, now, now, cleanupJobId),
    env.DB.prepare(`DELETE FROM cleanup_operation_leases WHERE cleanup_job_id = ?`).bind(cleanupJobId),
    env.DB.prepare(
      `INSERT INTO cleanup_job_events
        (id, cleanup_job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      cleanupJobId,
      `cleanup.${input.state}`,
      input.state,
      terminalPayload,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, ?, 'node', ?, 'cleanup_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `cleanup.operation.${input.state}`,
      nodeId,
      cleanupJobId,
      terminalPayload,
      now,
    ),
  ];

  if (input.state === "cleaned") {
    statements.push(
      env.DB.prepare(
        `UPDATE tenants
            SET status = 'decommissioned', assigned_node_id = NULL, database_name = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(now, current.tenant_id),
    );
  } else {
    statements.push(
      env.DB.prepare(`UPDATE tenants SET status = 'failed', updated_at = ? WHERE id = ?`).bind(now, current.tenant_id),
    );
  }

  await env.DB.batch(statements);
  return json({ status: "accepted", state: input.state });
}

export async function handleCleanupOperationRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const claimMatch = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/operations\/claim$/i);
  if (request.method === "POST" && claimMatch) {
    return await claimCleanupOperation(request, env, claimMatch[1]);
  }

  const resultMatch = url.pathname.match(
    /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
  );
  if (request.method === "POST" && resultMatch) {
    const exists = await env.DB.prepare(`SELECT id FROM cleanup_jobs WHERE id = ?`)
      .bind(resultMatch[2]).first<{ id: string }>();
    if (!exists) return null;
    return await reportCleanupResult(request, env, resultMatch[1], resultMatch[2]);
  }
  return null;
}
