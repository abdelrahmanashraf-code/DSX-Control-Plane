interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type JsonObject = Record<string, unknown>;

export const DEFAULT_TRIAL_CONVERSION_MODE = "clean_production" as const;
export const PRODUCTION_POOL = "production" as const;
export const TRIAL_CONVERSION_MODES = ["clean_production", "promote_trial_data"] as const;
export const TRIAL_CONVERSION_STATES = [
  "requested",
  "approved",
  "provisioning",
  "ready",
  "failed",
  "cancelled",
] as const;

type TrialConversionMode = (typeof TRIAL_CONVERSION_MODES)[number];

type TrialConversionRequestInput = {
  idempotency_key: string;
  mode: TrialConversionMode;
  confirm_data_promotion: boolean;
};

type TrialConversionApprovalInput = {
  production_name: string;
  production_slug: string;
};

type TrialRow = {
  id: string;
  name: string;
  slug: string;
  sector: string;
  environment_kind: string;
  trial_state: string | null;
  database_name: string | null;
};

type ConversionRow = {
  id: string;
  trial_tenant_id: string;
  request_key: string;
  mode: TrialConversionMode;
  state: string;
  target_tenant_id: string | null;
  promotion_confirmed_at: string | null;
  error_code: string | null;
  requested_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type TemplateRow = {
  id: string;
  sector: string;
};

type TargetTenantRow = {
  id: string;
  name: string;
  slug: string;
  sector: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
  database_name: string | null;
};

type ProvisioningJobRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  node_id: string | null;
  pool: string;
  state: string;
  idempotency_key: string;
  attempt: number;
  error_code: string | null;
};

const encoder = new TextEncoder();
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

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

export function productionSlugForConversion(trialSlug: string, conversionId: string): string {
  const token = conversionId.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 8) || "00000000";
  const suffix = `prod-${token}`;
  const maxBaseLength = 64 - suffix.length - 1;
  let base = trialSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/-+$/g, "");
  }
  if (base.length < 2) base = "trial";
  return `${base}-${suffix}`;
}

export function parseTrialConversionApprovalInput(
  input: Record<string, unknown>,
  trialName: string,
  trialSlug: string,
  conversionId: string,
): TrialConversionApprovalInput {
  const productionName = stringValue(input.production_name, 120)
    || `${trialName} Production`.slice(0, 120);

  const requestedSlug = typeof input.production_slug === "string"
    ? input.production_slug.trim().toLowerCase()
    : "";
  const productionSlug = requestedSlug || productionSlugForConversion(trialSlug, conversionId);

  if (!productionName) throw new Error("invalid_production_name");
  if (productionSlug.length < 2 || productionSlug.length > 64 || !SAFE_SLUG.test(productionSlug)) {
    throw new Error("invalid_production_slug");
  }

  return {
    production_name: productionName,
    production_slug: productionSlug,
  };
}

export function parseTrialConversionRequestInput(
  input: Record<string, unknown>,
): TrialConversionRequestInput {
  const idempotencyKey = stringValue(input.idempotency_key, 128);
  if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error("invalid_idempotency_key");
  }

  const rawMode = stringValue(input.mode, 32) || DEFAULT_TRIAL_CONVERSION_MODE;
  if (!TRIAL_CONVERSION_MODES.includes(rawMode as TrialConversionMode)) {
    throw new Error("invalid_conversion_mode");
  }

  const mode = rawMode as TrialConversionMode;
  const confirmDataPromotion = input.confirm_data_promotion === true;
  if (mode === "promote_trial_data" && !confirmDataPromotion) {
    throw new Error("data_promotion_confirmation_required");
  }

  return {
    idempotency_key: idempotencyKey,
    mode,
    confirm_data_promotion: confirmDataPromotion,
  };
}

function conversionSelectSql(whereClause: string): string {
  return `SELECT id, trial_tenant_id, request_key, mode, state, target_tenant_id,
                 promotion_confirmed_at, error_code, requested_at, updated_at, started_at, finished_at
            FROM trial_conversion_requests
           ${whereClause}`;
}

async function getConversionByRequestKey(env: Env, requestKey: string): Promise<ConversionRow | null> {
  return await env.DB.prepare(
    conversionSelectSql("WHERE request_key = ?"),
  ).bind(requestKey).first<ConversionRow>();
}

async function getConversionById(env: Env, conversionId: string): Promise<ConversionRow | null> {
  return await env.DB.prepare(
    conversionSelectSql("WHERE id = ?"),
  ).bind(conversionId).first<ConversionRow>();
}

async function getTargetTenant(env: Env, tenantId: string): Promise<TargetTenantRow | null> {
  return await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, status, assigned_node_id, database_name
       FROM tenants
      WHERE id = ?`,
  ).bind(tenantId).first<TargetTenantRow>();
}

async function getConversionProvisioningJob(
  env: Env,
  targetTenantId: string,
  conversionId: string,
): Promise<ProvisioningJobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt, error_code
       FROM provisioning_jobs
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).bind(targetTenantId, `conversion:${conversionId}`).first<ProvisioningJobRow>();
}

async function listConversions(request: Request, env: Env, trialTenantId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const trial = await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, trial_state, database_name
       FROM tenants WHERE id = ?`,
  ).bind(trialTenantId).first<TrialRow>();
  if (!trial || trial.environment_kind !== "trial") return json({ error: "trial_not_found" }, 404);

  const rows = await env.DB.prepare(
    conversionSelectSql(
      `WHERE trial_tenant_id = ?
       ORDER BY requested_at DESC
       LIMIT 50`,
    ),
  ).bind(trialTenantId).all<ConversionRow>();

  return json({ conversions: rows.results || [] });
}

async function createConversion(request: Request, env: Env, trialTenantId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: TrialConversionRequestInput;
  try {
    input = parseTrialConversionRequestInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_conversion_request" }, 400);
  }

  const trial = await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, trial_state, database_name
       FROM tenants WHERE id = ?`,
  ).bind(trialTenantId).first<TrialRow>();
  if (!trial || trial.environment_kind !== "trial") return json({ error: "trial_not_found" }, 404);

  const replay = await getConversionByRequestKey(env, input.idempotency_key);
  if (replay) {
    if (replay.trial_tenant_id !== trialTenantId) {
      return json({ error: "idempotency_key_in_use" }, 409);
    }
    return json({ conversion: replay, idempotent_replay: true });
  }

  if (input.mode === "promote_trial_data") {
    if (trial.trial_state !== "active" || !trial.database_name) {
      return json({ error: "trial_data_promotion_not_available" }, 409);
    }
  } else if (!new Set(["active", "expired", "cleaned"]).has(trial.trial_state || "")) {
    return json({ error: "trial_not_convertible" }, 409);
  }

  const existing = await env.DB.prepare(
    `SELECT id, state FROM trial_conversion_requests
      WHERE trial_tenant_id = ?
        AND state IN ('requested', 'approved', 'provisioning', 'ready')
      ORDER BY requested_at DESC
      LIMIT 1`,
  ).bind(trialTenantId).first<{ id: string; state: string }>();
  if (existing) {
    return json({ error: "conversion_already_exists", conversion_id: existing.id, state: existing.state }, 409);
  }

  const now = nowIso();
  const conversionId = crypto.randomUUID();
  const promotionConfirmedAt = input.mode === "promote_trial_data" ? now : null;
  const payload = JSON.stringify({ mode: input.mode, request_key: input.idempotency_key });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trial_conversion_requests
        (id, trial_tenant_id, request_key, mode, state, target_tenant_id,
         promotion_confirmed_at, error_code, requested_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'requested', NULL, ?, NULL, ?, ?, NULL, NULL)`,
    ).bind(
      conversionId,
      trialTenantId,
      input.idempotency_key,
      input.mode,
      promotionConfirmedAt,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.conversion.requested', 'admin', NULL, 'trial_conversion', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), conversionId, payload, now),
  ]);

  const created = await getConversionByRequestKey(env, input.idempotency_key);
  return json({ conversion: created, idempotent_replay: false }, 201);
}

async function approveCleanProductionConversion(
  request: Request,
  env: Env,
  trialTenantId: string,
  conversionId: string,
): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const trial = await env.DB.prepare(
    `SELECT id, name, slug, sector, environment_kind, trial_state, database_name
       FROM tenants WHERE id = ?`,
  ).bind(trialTenantId).first<TrialRow>();
  if (!trial || trial.environment_kind !== "trial") return json({ error: "trial_not_found" }, 404);

  const conversion = await getConversionById(env, conversionId);
  if (!conversion || conversion.trial_tenant_id !== trialTenantId) {
    return json({ error: "conversion_not_found" }, 404);
  }

  if (conversion.state === "approved" && conversion.target_tenant_id) {
    const targetTenant = await getTargetTenant(env, conversion.target_tenant_id);
    const provisioningJob = await getConversionProvisioningJob(
      env,
      conversion.target_tenant_id,
      conversion.id,
    );
    return json({
      conversion,
      target_tenant: targetTenant,
      provisioning_job: provisioningJob,
      idempotent_replay: true,
    });
  }
  if (conversion.state !== "requested") {
    return json({
      error: "invalid_conversion_transition",
      from_state: conversion.state,
      to_state: "approved",
    }, 409);
  }
  if (conversion.mode !== "clean_production") {
    return json({ error: "trial_data_promotion_requires_separate_flow" }, 409);
  }

  let input: TrialConversionApprovalInput;
  try {
    input = parseTrialConversionApprovalInput(body, trial.name, trial.slug, conversion.id);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_conversion_approval" }, 400);
  }

  const slugOwner = await env.DB.prepare(
    `SELECT id FROM tenants WHERE slug = ?`,
  ).bind(input.production_slug).first<{ id: string }>();
  if (slugOwner) {
    return json({ error: "production_slug_exists", tenant_id: slugOwner.id }, 409);
  }

  const template = await env.DB.prepare(
    `SELECT id, sector
       FROM provisioning_templates
      WHERE sector = ? AND active = 1
      ORDER BY version DESC
      LIMIT 1`,
  ).bind(trial.sector).first<TemplateRow>();
  if (!template) return json({ error: "active_template_not_found" }, 404);

  const now = nowIso();
  const targetTenantId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const jobIdempotencyKey = `conversion:${conversion.id}`;
  const approvalPayload = JSON.stringify({
    conversion_id: conversion.id,
    trial_tenant_id: trial.id,
    target_tenant_id: targetTenantId,
    template_id: template.id,
    pool: PRODUCTION_POOL,
    mode: conversion.mode,
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants
        (id, name, slug, sector, environment_kind, status, assigned_node_id, database_name,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'production', 'pending', NULL, NULL, ?, ?)`,
    ).bind(
      targetTenantId,
      input.production_name,
      input.production_slug,
      trial.sector,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO provisioning_jobs
        (id, tenant_id, template_id, node_id, pool, state, idempotency_key, attempt,
         error_code, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, NULL, ?, 'queued', ?, 0, NULL, ?, ?, NULL, NULL)`,
    ).bind(
      jobId,
      targetTenantId,
      template.id,
      PRODUCTION_POOL,
      jobIdempotencyKey,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
        (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'conversion.production.queued', NULL, 'queued', ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, approvalPayload, now),
    env.DB.prepare(
      `UPDATE trial_conversion_requests
          SET state = 'approved', target_tenant_id = ?, updated_at = ?
        WHERE id = ? AND state = 'requested'`,
    ).bind(targetTenantId, now, conversion.id),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.conversion.approved', 'admin', NULL, 'trial_conversion', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), conversion.id, approvalPayload, now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'tenant.created.from_trial_conversion', 'admin', NULL, 'tenant', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), targetTenantId, approvalPayload, now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'provisioning.job.queued.from_trial_conversion', 'admin', NULL,
               'provisioning_job', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), jobId, approvalPayload, now),
  ]);

  const approved = await getConversionById(env, conversion.id);
  const targetTenant = await getTargetTenant(env, targetTenantId);
  const provisioningJob = await getConversionProvisioningJob(env, targetTenantId, conversion.id);

  return json({
    conversion: approved,
    target_tenant: targetTenant,
    provisioning_job: provisioningJob,
    idempotent_replay: false,
    execution_gate: "production_placement_required",
  }, 201);
}

export async function handleTrialConversionAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  const approveMatch = url.pathname.match(
    /^\/v1\/admin\/trials\/([0-9a-f-]+)\/conversions\/([0-9a-f-]+)\/approve$/i,
  );
  if (approveMatch) {
    if (request.method === "POST") {
      return await approveCleanProductionConversion(request, env, approveMatch[1], approveMatch[2]);
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  const match = url.pathname.match(/^\/v1\/admin\/trials\/([0-9a-f-]+)\/conversions$/i);
  if (!match) return null;

  if (request.method === "GET") return await listConversions(request, env, match[1]);
  if (request.method === "POST") return await createConversion(request, env, match[1]);
  return json({ error: "method_not_allowed" }, 405);
}
