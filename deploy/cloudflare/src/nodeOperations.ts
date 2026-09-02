import { canTransitionProvisioningState, type ProvisioningState } from "./provisioning.ts";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

type JsonObject = Record<string, unknown>;

type ClaimedJobRow = {
  job_id: string;
};

type OperationSourceRow = {
  job_id: string;
  state: ProvisioningState;
  tenant_id: string;
  tenant_slug: string;
  sector: string;
  environment_kind: string;
  template_id: string;
  template_version: number;
  odoo_major: number;
  database_prefix: string;
  module_manifest: string;
};

type LeaseRow = {
  job_id: string;
  node_id: string;
  lease_expires_at: string;
};

type JobStateRow = {
  state: ProvisioningState;
  tenant_id: string;
  database_prefix: string;
  tenant_slug: string;
};

export type OperationResultInput = {
  lease_token: string;
  state: "running" | "ready" | "failed";
  error_code: string | null;
  database_name: string | null;
};

const encoder = new TextEncoder();
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{2,62}$/;
const SAFE_MODULE = /^[a-zA-Z0-9_]{1,120}$/;

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

async function authenticateNode(request: Request, env: Env, nodeId: string): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT id
       FROM nodes
      WHERE id = ?
        AND lifecycle_state = 'active'
        AND revoked_at IS NULL
        AND agent_token_hash = ?`,
  ).bind(nodeId, tokenHash).first<{ id: string }>();
  return Boolean(row);
}

function leaseSeconds(env: Env): number {
  const parsed = Number(env.NODE_OPERATION_LEASE_SECONDS || 600);
  if (!Number.isFinite(parsed)) return 600;
  return Math.max(120, Math.min(1800, Math.trunc(parsed)));
}

function parseModules(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const modules = parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => SAFE_MODULE.test(item));
    return [...new Set(modules)].slice(0, 100);
  } catch {
    return [];
  }
}

export function expectedDatabaseName(databasePrefix: string, tenantSlug: string, tenantId: string): string {
  const safeSlug = tenantSlug.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
  const suffix = tenantId.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 8) || "tenant";
  return `${databasePrefix}_${safeSlug}_${suffix}`.slice(0, 63);
}

export function buildProvisionOperationPayload(source: OperationSourceRow): JsonObject {
  return {
    tenant_id: source.tenant_id,
    tenant_slug: source.tenant_slug,
    sector: source.sector,
    environment_kind: source.environment_kind,
    template_id: source.template_id,
    template_version: source.template_version,
    odoo_major: source.odoo_major,
    database_name: expectedDatabaseName(source.database_prefix, source.tenant_slug, source.tenant_id),
    modules: parseModules(source.module_manifest),
  };
}

export function parseOperationResult(input: Record<string, unknown>): OperationResultInput {
  const leaseToken = typeof input.lease_token === "string" ? input.lease_token.trim().slice(0, 256) : "";
  const state = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  const errorCode = typeof input.error_code === "string" ? input.error_code.trim().toLowerCase().slice(0, 120) : null;
  const databaseName = typeof input.database_name === "string" ? input.database_name.trim().toLowerCase().slice(0, 63) : null;

  if (leaseToken.length < 16) throw new Error("invalid_lease_token");
  if (!new Set(["running", "ready", "failed"]).has(state)) throw new Error("invalid_operation_state");
  if (errorCode !== null && !SAFE_CODE.test(errorCode)) throw new Error("invalid_error_code");
  if (state === "ready" && (!databaseName || !SAFE_DATABASE.test(databaseName))) {
    throw new Error("invalid_database_name");
  }

  return {
    lease_token: leaseToken,
    state: state as OperationResultInput["state"],
    error_code: state === "failed" ? errorCode || "operation_failed" : null,
    database_name: state === "ready" ? databaseName : null,
  };
}

async function markExpiredLeases(env: Env, nodeId: string): Promise<void> {
  const now = nowIso();
  const expired = await env.DB.prepare(
    `SELECT l.job_id
       FROM provisioning_operation_leases l
       JOIN provisioning_jobs j ON j.id = l.job_id
      WHERE l.node_id = ?
        AND l.lease_expires_at <= ?
        AND j.state IN ('dispatched', 'running')
      ORDER BY l.lease_expires_at ASC
      LIMIT 20`,
  ).bind(nodeId, now).all<{ job_id: string }>();

  for (const row of expired.results) {
    const tenant = await env.DB.prepare(
      `SELECT tenant_id, state FROM provisioning_jobs WHERE id = ?`,
    ).bind(row.job_id).first<{ tenant_id: string; state: ProvisioningState }>();
    if (!tenant) continue;

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provisioning_jobs
            SET state = 'failed', error_code = 'operation_lease_expired', updated_at = ?, finished_at = ?
          WHERE id = ? AND state IN ('dispatched', 'running')`,
      ).bind(now, now, row.job_id),
      env.DB.prepare(
        `UPDATE tenants SET status = 'failed', updated_at = ? WHERE id = ?`,
      ).bind(now, tenant.tenant_id),
      env.DB.prepare(`DELETE FROM provisioning_operation_leases WHERE job_id = ?`).bind(row.job_id),
      env.DB.prepare(
        `INSERT INTO provisioning_job_events
           (id, job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'provisioning.failed', ?, 'failed', '{"error_code":"operation_lease_expired"}', ?)`,
      ).bind(crypto.randomUUID(), row.job_id, tenant.state, now),
    ]);
  }
}

async function claimNextOperation(request: Request, env: Env, nodeId: string): Promise<Response> {
  if (!(await authenticateNode(request, env, nodeId))) return json({ error: "invalid_or_revoked_agent" }, 401);

  await markExpiredLeases(env, nodeId);

  const leaseToken = randomSecret("dsx_lease");
  const leaseHash = await sha256(leaseToken);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();

  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO provisioning_operation_leases
       (job_id, node_id, lease_token_hash, lease_expires_at, created_at, updated_at)
     SELECT j.id, j.node_id, ?, ?, ?, ?
       FROM provisioning_jobs j
      WHERE j.node_id = ?
        AND j.state IN ('placed', 'retrying')
        AND NOT EXISTS (
          SELECT 1 FROM provisioning_operation_leases existing WHERE existing.job_id = j.id
        )
      ORDER BY j.created_at ASC
      LIMIT 1
     RETURNING job_id`,
  ).bind(leaseHash, expiresAt, createdAt, createdAt, nodeId).first<ClaimedJobRow>();

  if (!claimed) return json({ operation: null });

  const source = await env.DB.prepare(
    `SELECT j.id AS job_id, j.state,
            t.id AS tenant_id, t.slug AS tenant_slug, t.sector, t.environment_kind,
            p.id AS template_id, p.version AS template_version, p.odoo_major,
            p.database_prefix, p.module_manifest
       FROM provisioning_jobs j
       JOIN tenants t ON t.id = j.tenant_id
       JOIN provisioning_templates p ON p.id = j.template_id AND p.active = 1
      WHERE j.id = ? AND j.node_id = ?`,
  ).bind(claimed.job_id, nodeId).first<OperationSourceRow>();

  if (!source || !canTransitionProvisioningState(source.state, "dispatched")) {
    await env.DB.prepare(`DELETE FROM provisioning_operation_leases WHERE job_id = ?`).bind(claimed.job_id).run();
    return json({ error: "operation_claim_conflict" }, 409);
  }

  const payload = buildProvisionOperationPayload(source);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE provisioning_jobs
          SET state = 'dispatched', attempt = attempt + 1, error_code = NULL, updated_at = ?, finished_at = NULL
        WHERE id = ? AND node_id = ? AND state = ?`,
    ).bind(createdAt, source.job_id, nodeId, source.state),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
         (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'provisioning.dispatched', ?, 'dispatched', ?, ?)`,
    ).bind(crypto.randomUUID(), source.job_id, source.state, JSON.stringify({ node_id: nodeId }), createdAt),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'provisioning.operation.claimed', 'node', ?, 'provisioning_job', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), nodeId, source.job_id, JSON.stringify({ operation_type: "provision_odoo_environment" }), createdAt),
  ]);

  return json({
    operation: {
      id: source.job_id,
      type: "provision_odoo_environment",
      lease_token: leaseToken,
      lease_expires_at: expiresAt,
      payload,
    },
  });
}

async function reportOperationResult(
  request: Request,
  env: Env,
  nodeId: string,
  jobId: string,
): Promise<Response> {
  if (!(await authenticateNode(request, env, nodeId))) return json({ error: "invalid_or_revoked_agent" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: OperationResultInput;
  try {
    input = parseOperationResult(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_operation_result" }, 400);
  }

  const leaseHash = await sha256(input.lease_token);
  const now = nowIso();
  const lease = await env.DB.prepare(
    `SELECT job_id, node_id, lease_expires_at
       FROM provisioning_operation_leases
      WHERE job_id = ? AND node_id = ? AND lease_token_hash = ? AND lease_expires_at > ?`,
  ).bind(jobId, nodeId, leaseHash, now).first<LeaseRow>();
  if (!lease) return json({ error: "operation_lease_expired_or_invalid" }, 409);

  const current = await env.DB.prepare(
    `SELECT j.state, j.tenant_id, p.database_prefix, t.slug AS tenant_slug
       FROM provisioning_jobs j
       JOIN provisioning_templates p ON p.id = j.template_id
       JOIN tenants t ON t.id = j.tenant_id
      WHERE j.id = ? AND j.node_id = ?`,
  ).bind(jobId, nodeId).first<JobStateRow>();
  if (!current) return json({ error: "provisioning_job_not_found" }, 404);

  if (input.state === "running" && current.state === "running") {
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE provisioning_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE job_id = ?`,
    ).bind(renewedUntil, now, jobId).run();
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  if (!canTransitionProvisioningState(current.state, input.state)) {
    return json({ error: "invalid_operation_transition", from_state: current.state, to_state: input.state }, 409);
  }

  if (input.state === "ready") {
    const expected = expectedDatabaseName(current.database_prefix, current.tenant_slug, current.tenant_id);
    if (input.database_name !== expected) return json({ error: "database_name_mismatch" }, 409);
  }

  if (input.state === "running") {
    const renewedUntil = new Date(Date.now() + leaseSeconds(env) * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provisioning_jobs SET state = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
      ).bind(now, now, jobId),
      env.DB.prepare(
        `UPDATE provisioning_operation_leases SET lease_expires_at = ?, updated_at = ? WHERE job_id = ?`,
      ).bind(renewedUntil, now, jobId),
      env.DB.prepare(
        `INSERT INTO provisioning_job_events
           (id, job_id, event_type, from_state, to_state, payload, created_at)
         VALUES (?, ?, 'provisioning.running', ?, 'running', '{}', ?)`,
      ).bind(crypto.randomUUID(), jobId, current.state, now),
    ]);
    return json({ status: "accepted", state: "running", lease_expires_at: renewedUntil });
  }

  const eventPayload = input.state === "ready"
    ? JSON.stringify({ database_name: input.database_name })
    : JSON.stringify({ error_code: input.error_code });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE provisioning_jobs
          SET state = ?, error_code = ?, updated_at = ?, finished_at = ?
        WHERE id = ?`,
    ).bind(input.state, input.error_code, now, now, jobId),
    env.DB.prepare(`DELETE FROM provisioning_operation_leases WHERE job_id = ?`).bind(jobId),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
         (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      jobId,
      `provisioning.${input.state}`,
      current.state,
      input.state,
      eventPayload,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, ?, 'node', ?, 'provisioning_job', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      `provisioning.operation.${input.state}`,
      nodeId,
      jobId,
      eventPayload,
      now,
    ),
  ];

  if (input.state === "ready") {
    statements.push(
      env.DB.prepare(
        `UPDATE tenants SET status = 'ready', database_name = ?, updated_at = ? WHERE id = ?`,
      ).bind(input.database_name, now, current.tenant_id),
    );
  } else {
    statements.push(
      env.DB.prepare(`UPDATE tenants SET status = 'failed', updated_at = ? WHERE id = ?`).bind(now, current.tenant_id),
    );
  }

  await env.DB.batch(statements);
  return json({ status: "accepted", state: input.state });
}

export async function handleNodeOperationRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  const claimMatch = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/operations\/claim$/i);
  if (request.method === "POST" && claimMatch) {
    return await claimNextOperation(request, env, claimMatch[1]);
  }

  const resultMatch = url.pathname.match(
    /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
  );
  if (request.method === "POST" && resultMatch) {
    return await reportOperationResult(request, env, resultMatch[1], resultMatch[2]);
  }

  return null;
}
