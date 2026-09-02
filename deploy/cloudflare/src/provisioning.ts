interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_OFFLINE_SECONDS?: string;
}

type JsonObject = Record<string, unknown>;

export type ProvisioningState =
  | "queued"
  | "placed"
  | "dispatched"
  | "running"
  | "ready"
  | "failed"
  | "retrying";

export type TenantInput = {
  name: string;
  slug: string;
  sector: "restaurant" | "cafe" | "retail" | "supermarket";
  environment_kind: "test" | "trial" | "production";
};

export type ProvisioningJobInput = {
  tenant_id: string;
  template_id: string;
  idempotency_key: string;
  pool: string;
};

export type PlacementCandidate = {
  id: string;
  lifecycle_state: string;
  role: string;
  pool: string;
  last_seen_at: string | null;
  max_tenants: number | null;
  reserved_memory_mb: number;
  reserved_disk_gb: number;
  tenant_count: number;
  metrics: unknown;
};

export type PlacementRequirements = {
  required_role: string;
  min_memory_mb: number;
  min_disk_gb: number;
  pool: string;
};

type TemplateRow = {
  id: string;
  sector: string;
  name: string;
  version: number;
  odoo_major: number;
  required_role: string;
  min_memory_mb: number;
  min_disk_gb: number;
  database_prefix: string;
  module_manifest: string;
  settings_manifest: string;
  active: number;
  created_at: string;
  updated_at: string;
};

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  sector: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
  database_name: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  node_id: string | null;
  pool: string;
  state: ProvisioningState;
  idempotency_key: string;
  attempt: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type EventRow = {
  id: string;
  job_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload: string;
  created_at: string;
};

type NodePlacementRow = PlacementCandidate & {
  metrics: string;
};

const encoder = new TextEncoder();
const SECTORS = new Set(["restaurant", "cafe", "retail", "supermarket"]);
const ENVIRONMENT_KINDS = new Set(["test", "trial", "production"]);
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const TRANSITIONS: Record<ProvisioningState, ReadonlySet<ProvisioningState>> = {
  queued: new Set(["placed", "failed"]),
  placed: new Set(["dispatched", "failed"]),
  dispatched: new Set(["running", "failed"]),
  running: new Set(["ready", "failed"]),
  ready: new Set(),
  failed: new Set(["retrying"]),
  retrying: new Set(["dispatched", "failed"]),
};

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

function parseObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function nestedNumber(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capacity(candidate: PlacementCandidate): { memory_mb: number; disk_gb: number } | null {
  const metrics = parseObject(candidate.metrics);
  const memory = parseObject(metrics.memory);
  const disk = parseObject(metrics.disk);
  const memoryBytes = nestedNumber(memory, "available_bytes");
  const diskBytes = nestedNumber(disk, "free_bytes");
  if (memoryBytes === null || diskBytes === null) return null;

  return {
    memory_mb: memoryBytes / (1024 * 1024) - candidate.reserved_memory_mb,
    disk_gb: diskBytes / (1024 * 1024 * 1024) - candidate.reserved_disk_gb,
  };
}

export function canTransitionProvisioningState(
  from: ProvisioningState,
  to: ProvisioningState,
): boolean {
  return TRANSITIONS[from].has(to);
}

export function parseTenantInput(input: Record<string, unknown>): TenantInput {
  const name = stringValue(input.name, 120);
  const slug = stringValue(input.slug, 64).toLowerCase();
  const sector = stringValue(input.sector, 32).toLowerCase();
  const environmentKind = stringValue(input.environment_kind ?? "test", 32).toLowerCase();

  if (!name) throw new Error("invalid_tenant_name");
  if (slug.length < 2 || !SAFE_SLUG.test(slug)) throw new Error("invalid_tenant_slug");
  if (!SECTORS.has(sector)) throw new Error("invalid_sector");
  if (!ENVIRONMENT_KINDS.has(environmentKind)) throw new Error("invalid_environment_kind");

  return {
    name,
    slug,
    sector: sector as TenantInput["sector"],
    environment_kind: environmentKind as TenantInput["environment_kind"],
  };
}

export function parseProvisioningJobInput(input: Record<string, unknown>): ProvisioningJobInput {
  const tenantId = stringValue(input.tenant_id, 64);
  const templateId = stringValue(input.template_id, 96).toLowerCase();
  const idempotencyKey = stringValue(input.idempotency_key, 128);
  const pool = stringValue(input.pool ?? "non-production", 64).toLowerCase();

  if (!tenantId) throw new Error("invalid_tenant_id");
  if (!SAFE_TEMPLATE_ID.test(templateId)) throw new Error("invalid_template_id");
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error("invalid_idempotency_key");
  if (!SAFE_NAME.test(pool)) throw new Error("invalid_pool");

  return {
    tenant_id: tenantId,
    template_id: templateId,
    idempotency_key: idempotencyKey,
    pool,
  };
}

export function selectPlacementNode(
  candidates: PlacementCandidate[],
  requirements: PlacementRequirements,
  nowMs = Date.now(),
  offlineSeconds = 300,
): PlacementCandidate | null {
  const eligible = candidates
    .map((candidate) => {
      if (candidate.lifecycle_state !== "active") return null;
      if (candidate.role !== requirements.required_role || candidate.pool !== requirements.pool) return null;
      if (!candidate.last_seen_at) return null;

      const seenAt = new Date(candidate.last_seen_at).getTime();
      if (Number.isNaN(seenAt) || (nowMs - seenAt) / 1000 > offlineSeconds) return null;
      if (candidate.max_tenants !== null && candidate.tenant_count >= candidate.max_tenants) return null;

      const available = capacity(candidate);
      if (!available) return null;
      if (available.memory_mb < requirements.min_memory_mb) return null;
      if (available.disk_gb < requirements.min_disk_gb) return null;

      const tenantRatio = candidate.max_tenants
        ? candidate.tenant_count / candidate.max_tenants
        : candidate.tenant_count / 10000;
      return { candidate, tenantRatio, available };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => {
      if (left.tenantRatio !== right.tenantRatio) return left.tenantRatio - right.tenantRatio;
      if (left.available.disk_gb !== right.available.disk_gb) {
        return right.available.disk_gb - left.available.disk_gb;
      }
      if (left.available.memory_mb !== right.available.memory_mb) {
        return right.available.memory_mb - left.available.memory_mb;
      }
      return left.candidate.id.localeCompare(right.candidate.id);
    });

  return eligible[0]?.candidate ?? null;
}

function publicTemplate(row: TemplateRow): JsonObject {
  return {
    ...row,
    active: Boolean(row.active),
    module_manifest: Array.isArray(JSON.parse(row.module_manifest)) ? JSON.parse(row.module_manifest) : [],
    settings_manifest: parseObject(row.settings_manifest),
  };
}

async function listTemplates(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `SELECT id, sector, name, version, odoo_major, required_role, min_memory_mb, min_disk_gb,
            database_prefix, module_manifest, settings_manifest, active, created_at, updated_at
       FROM provisioning_templates
      WHERE active = 1
      ORDER BY sector ASC`,
  ).all<TemplateRow>();
  return json({ templates: result.results.map(publicTemplate) });
}

async function createTenant(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: TenantInput;
  try {
    input = parseTenantInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_tenant" }, 400);
  }

  const existing = await env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(input.slug).first<{ id: string }>();
  if (existing) return json({ error: "tenant_slug_exists", tenant_id: existing.id }, 409);

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants
         (id, name, slug, sector, environment_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(id, input.name, input.slug, input.sector, input.environment_kind, createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'tenant.created', 'admin', 'admin-api', 'tenant', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({ slug: input.slug, sector: input.sector, environment_kind: input.environment_kind }),
      createdAt,
    ),
  ]);

  return json({ tenant: { id, ...input, status: "pending", assigned_node_id: null, database_name: null } }, 201);
}

async function listTenants(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, status, assigned_node_id, database_name,
            created_at, updated_at
       FROM tenants
      ORDER BY created_at DESC
      LIMIT 500`,
  ).all<TenantRow>();
  return json({ tenants: result.results });
}

async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
            error_code, created_at, updated_at, started_at, finished_at
       FROM provisioning_jobs
      WHERE id = ?`,
  ).bind(jobId).first<JobRow>();
}

async function createProvisioningJob(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: ProvisioningJobInput;
  try {
    input = parseProvisioningJobInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_provisioning_job" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
            error_code, created_at, updated_at, started_at, finished_at
       FROM provisioning_jobs
      WHERE tenant_id = ? AND idempotency_key = ?`,
  ).bind(input.tenant_id, input.idempotency_key).first<JobRow>();
  if (existing) return json({ job: existing, idempotent_replay: true });

  const tenant = await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, status, assigned_node_id, database_name,
            created_at, updated_at
       FROM tenants WHERE id = ?`,
  ).bind(input.tenant_id).first<TenantRow>();
  if (!tenant) return json({ error: "tenant_not_found" }, 404);
  if (!new Set(["pending", "failed"]).has(tenant.status)) {
    return json({ error: "tenant_not_provisionable", tenant_status: tenant.status }, 409);
  }

  const template = await env.DB.prepare(
    `SELECT id, sector, name, version, odoo_major, required_role, min_memory_mb, min_disk_gb,
            database_prefix, module_manifest, settings_manifest, active, created_at, updated_at
       FROM provisioning_templates WHERE id = ? AND active = 1`,
  ).bind(input.template_id).first<TemplateRow>();
  if (!template) return json({ error: "active_template_not_found" }, 404);
  if (template.sector !== tenant.sector) return json({ error: "template_sector_mismatch" }, 409);

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
      pool: input.pool,
    },
    Date.now(),
    offlineSeconds,
  );
  if (!placement) return json({ error: "no_eligible_node", pool: input.pool }, 409);

  const jobId = crypto.randomUUID();
  const createdAt = nowIso();
  const placementPayload = JSON.stringify({
    node_id: placement.id,
    pool: input.pool,
    required_role: template.required_role,
    template_id: template.id,
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO provisioning_jobs
         (id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'placed', ?, 0, ?, ?)`,
    ).bind(jobId, tenant.id, template.id, placement.id, input.pool, input.idempotency_key, createdAt, createdAt),
    env.DB.prepare(
      `UPDATE tenants
          SET status = 'provisioning', assigned_node_id = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(placement.id, createdAt, tenant.id),
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
       VALUES (?, 'provisioning.job.created', 'admin', 'admin-api', 'provisioning_job', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, placementPayload, createdAt),
  ]);

  const job = await getJob(env, jobId);
  return json({ job, idempotent_replay: false }, 201);
}

async function listProvisioningJobs(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
            error_code, created_at, updated_at, started_at, finished_at
       FROM provisioning_jobs
      ORDER BY created_at DESC
      LIMIT 200`,
  ).all<JobRow>();
  return json({ jobs: result.results });
}

async function getProvisioningJob(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const job = await getJob(env, jobId);
  if (!job) return json({ error: "provisioning_job_not_found" }, 404);

  const events = await env.DB.prepare(
    `SELECT id, job_id, event_type, from_state, to_state, payload, created_at
       FROM provisioning_job_events
      WHERE job_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
  ).bind(jobId).all<EventRow>();

  return json({
    job,
    events: events.results.map((event) => ({ ...event, payload: parseObject(event.payload) })),
  });
}

export async function handleProvisioningAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/v1/admin/provisioning/templates") {
    return await listTemplates(request, env);
  }
  if (url.pathname === "/v1/admin/tenants") {
    if (request.method === "GET") return await listTenants(request, env);
    if (request.method === "POST") return await createTenant(request, env);
  }
  if (url.pathname === "/v1/admin/provisioning-jobs") {
    if (request.method === "GET") return await listProvisioningJobs(request, env);
    if (request.method === "POST") return await createProvisioningJob(request, env);
  }

  const jobMatch = url.pathname.match(/^\/v1\/admin\/provisioning-jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && jobMatch) {
    return await getProvisioningJob(request, env, jobMatch[1]);
  }

  return null;
}
