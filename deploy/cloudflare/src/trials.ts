import {
  parseTenantInput,
  selectPlacementNode,
  type PlacementCandidate,
} from "./provisioning.ts";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_OFFLINE_SECONDS?: string;
  TRIAL_BASE_DOMAIN?: string;
}

type JsonObject = Record<string, unknown>;

export type TrialRequestInput = {
  name: string;
  slug: string;
  sector: "restaurant" | "cafe" | "retail" | "supermarket";
  idempotency_key: string;
};

type TemplateRow = {
  id: string;
  sector: string;
  required_role: string;
  min_memory_mb: number;
  min_disk_gb: number;
};

type NodePlacementRow = PlacementCandidate & {
  tenant_count: number;
  metrics: string;
};

type TrialRow = {
  id: string;
  name: string;
  slug: string;
  sector: string;
  environment_kind: string;
  status: string;
  trial_state: string | null;
  trial_request_key: string | null;
  trial_requested_at: string | null;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  trial_expired_at: string | null;
  public_hostname: string | null;
  assigned_node_id: string | null;
  database_name: string | null;
  cleanup_job_id: string | null;
  cleanup_state: string | null;
  cleanup_error_code: string | null;
  created_at: string;
  updated_at: string;
};

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
};

const encoder = new TextEncoder();
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_BASE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const TRIAL_POOL = "trial";
export const TRIAL_DURATION_DAYS = 3;

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

export function parseTrialRequestInput(input: Record<string, unknown>): TrialRequestInput {
  const tenant = parseTenantInput({
    name: input.name,
    slug: input.slug,
    sector: input.sector,
    environment_kind: "trial",
  });
  const idempotencyKey = stringValue(input.idempotency_key, 128);
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error("invalid_idempotency_key");
  }

  return {
    name: tenant.name,
    slug: tenant.slug,
    sector: tenant.sector,
    idempotency_key: idempotencyKey,
  };
}

export function trialExpiryFrom(startedAt: string): string {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) throw new Error("invalid_trial_start");
  return new Date(start.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function trialHostname(slug: string, baseDomain?: string): string | null {
  const normalized = baseDomain?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") || "";
  if (!normalized || !SAFE_BASE_DOMAIN.test(normalized)) return null;
  return `${slug}.${normalized}`;
}

async function findJobForTenant(env: Env, tenantId: string): Promise<JobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
            error_code, created_at, updated_at
       FROM provisioning_jobs
      WHERE tenant_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
  ).bind(tenantId).first<JobRow>();
}

function trialSelectSql(whereClause: string): string {
  return `SELECT t.id, t.name, t.slug, t.sector, t.environment_kind, t.status, t.trial_state,
          t.trial_request_key, t.trial_requested_at, t.trial_started_at, t.trial_expires_at,
          t.trial_expired_at, t.public_hostname, t.assigned_node_id, t.database_name,
          (SELECT c.id FROM cleanup_jobs c WHERE c.tenant_id = t.id ORDER BY c.created_at DESC LIMIT 1)
            AS cleanup_job_id,
          (SELECT c.state FROM cleanup_jobs c WHERE c.tenant_id = t.id ORDER BY c.created_at DESC LIMIT 1)
            AS cleanup_state,
          (SELECT c.error_code FROM cleanup_jobs c WHERE c.tenant_id = t.id ORDER BY c.created_at DESC LIMIT 1)
            AS cleanup_error_code,
          t.created_at, t.updated_at
     FROM tenants t
    ${whereClause}`;
}

async function getTrialByRequestKey(env: Env, requestKey: string): Promise<TrialRow | null> {
  return await env.DB.prepare(
    trialSelectSql("WHERE t.environment_kind = 'trial' AND t.trial_request_key = ?"),
  ).bind(requestKey).first<TrialRow>();
}

async function createTrial(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: TrialRequestInput;
  try {
    input = parseTrialRequestInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_trial_request" }, 400);
  }

  const replay = await getTrialByRequestKey(env, input.idempotency_key);
  if (replay) {
    return json({
      trial: replay,
      provisioning_job: await findJobForTenant(env, replay.id),
      idempotent_replay: true,
    });
  }

  const slugOwner = await env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`)
    .bind(input.slug).first<{ id: string }>();
  if (slugOwner) return json({ error: "tenant_slug_exists", tenant_id: slugOwner.id }, 409);

  const template = await env.DB.prepare(
    `SELECT id, sector, required_role, min_memory_mb, min_disk_gb
       FROM provisioning_templates
      WHERE sector = ? AND active = 1
      LIMIT 1`,
  ).bind(input.sector).first<TemplateRow>();
  if (!template) return json({ error: "active_template_not_found", sector: input.sector }, 404);

  const nodes = await env.DB.prepare(
    `SELECT n.id, n.lifecycle_state, n.role, n.pool, n.last_seen_at, n.max_tenants,
            n.reserved_memory_mb, n.reserved_disk_gb, n.metrics,
            COUNT(t.id) AS tenant_count
       FROM nodes n
       LEFT JOIN tenants t
         ON t.assigned_node_id = n.id
        AND t.status <> 'decommissioned'
      GROUP BY n.id, n.lifecycle_state, n.role, n.pool, n.last_seen_at, n.max_tenants,
               n.reserved_memory_mb, n.reserved_disk_gb, n.metrics`,
  ).all<NodePlacementRow>();

  const offlineSeconds = Math.max(120, Number(env.NODE_OFFLINE_SECONDS || 300));
  const placement = selectPlacementNode(
    nodes.results.map((row) => ({ ...row, tenant_count: Number(row.tenant_count || 0) })),
    {
      required_role: template.required_role,
      min_memory_mb: template.min_memory_mb,
      min_disk_gb: template.min_disk_gb,
      pool: TRIAL_POOL,
    },
    Date.now(),
    offlineSeconds,
  );
  if (!placement) return json({ error: "no_eligible_trial_node", pool: TRIAL_POOL }, 409);

  const tenantId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const createdAt = nowIso();
  const publicHostname = trialHostname(input.slug, env.TRIAL_BASE_DOMAIN);
  const placementPayload = JSON.stringify({
    node_id: placement.id,
    pool: TRIAL_POOL,
    template_id: template.id,
    environment_kind: "trial",
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants
         (id, name, slug, sector, environment_kind, status, assigned_node_id,
          trial_state, trial_request_key, trial_requested_at, trial_expires_at, public_hostname,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'trial', 'provisioning', ?, 'provisioning', ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      tenantId,
      input.name,
      input.slug,
      input.sector,
      placement.id,
      input.idempotency_key,
      createdAt,
      publicHostname,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO provisioning_jobs
         (id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'placed', ?, 0, ?, ?)`,
    ).bind(
      jobId,
      tenantId,
      template.id,
      placement.id,
      TRIAL_POOL,
      input.idempotency_key,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
         (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'provisioning.queued', NULL, 'queued', '{}', ?)`,
    ).bind(crypto.randomUUID(), jobId, createdAt),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
         (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'provisioning.placed', 'queued', 'placed', ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, placementPayload, createdAt),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.request.created', 'admin', 'admin-api', 'tenant', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      tenantId,
      JSON.stringify({
        slug: input.slug,
        sector: input.sector,
        duration_days: TRIAL_DURATION_DAYS,
        node_id: placement.id,
        public_hostname: publicHostname,
      }),
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'provisioning.job.created', 'admin', 'admin-api', 'provisioning_job', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, placementPayload, createdAt),
  ]);

  const trial = await getTrialByRequestKey(env, input.idempotency_key);
  const job = await findJobForTenant(env, tenantId);
  return json({ trial, provisioning_job: job, idempotent_replay: false }, 201);
}

async function listTrials(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `${trialSelectSql("WHERE t.environment_kind = 'trial'")}
     ORDER BY t.created_at DESC
     LIMIT 500`,
  ).all<TrialRow>();
  return json({ trials: result.results });
}

export async function handleTrialAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/admin/trials") return null;
  if (request.method === "GET") return await listTrials(request, env);
  if (request.method === "POST") return await createTrial(request, env);
  return null;
}
