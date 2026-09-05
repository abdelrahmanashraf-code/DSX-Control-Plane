import {
  selectPlacementNode,
  type PlacementCandidate,
} from "./provisioning.ts";
import { PRODUCTION_POOL } from "./trialConversion.ts";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_OFFLINE_SECONDS?: string;
  PRODUCTION_PROVISIONING_ENABLED?: string;
}

type JsonObject = Record<string, unknown>;

type ConversionRow = {
  id: string;
  trial_tenant_id: string;
  mode: string;
  state: string;
  target_tenant_id: string | null;
};

type TenantRow = {
  id: string;
  sector: string;
  environment_kind: string;
  status: string;
  assigned_node_id: string | null;
};

type JobRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  node_id: string | null;
  pool: string;
  state: string;
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
};

export type ProductionPlacementInput = {
  confirm_production_placement: true;
  node_id: string;
};

const encoder = new TextEncoder();
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function productionExecutionEnabled(value?: string): boolean {
  return (value || "").trim().toLowerCase() === "true";
}

export function parseProductionPlacementInput(input: Record<string, unknown>): ProductionPlacementInput {
  if (input.confirm_production_placement !== true) {
    throw new Error("production_placement_confirmation_required");
  }

  const nodeId = typeof input.node_id === "string" ? input.node_id.trim().toLowerCase() : "";
  if (!SAFE_UUID.test(nodeId)) throw new Error("invalid_production_node_id");

  return {
    confirm_production_placement: true,
    node_id: nodeId,
  };
}

async function getConversion(env: Env, trialTenantId: string, conversionId: string): Promise<ConversionRow | null> {
  return await env.DB.prepare(
    `SELECT id, trial_tenant_id, mode, state, target_tenant_id
       FROM trial_conversion_requests
      WHERE id = ? AND trial_tenant_id = ?`,
  ).bind(conversionId, trialTenantId).first<ConversionRow>();
}

async function getJob(env: Env, targetTenantId: string, conversionId: string): Promise<JobRow | null> {
  return await env.DB.prepare(
    `SELECT id, tenant_id, template_id, node_id, pool, state, idempotency_key
       FROM provisioning_jobs
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).bind(targetTenantId, `conversion:${conversionId}`).first<JobRow>();
}

async function placeProduction(
  request: Request,
  env: Env,
  trialTenantId: string,
  conversionId: string,
): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  let input: ProductionPlacementInput;
  try {
    input = parseProductionPlacementInput(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid_production_placement" }, 400);
  }

  // Fail closed even with a valid admin request. Deployment must explicitly
  // opt in before a production job can ever move from queued -> placed.
  if (!productionExecutionEnabled(env.PRODUCTION_PROVISIONING_ENABLED)) {
    return json({ error: "production_execution_disabled" }, 409);
  }

  const conversion = await getConversion(env, trialTenantId, conversionId);
  if (!conversion) return json({ error: "conversion_not_found" }, 404);
  if (conversion.mode !== "clean_production") {
    return json({ error: "trial_data_promotion_requires_separate_flow" }, 409);
  }
  if (!conversion.target_tenant_id) {
    return json({ error: "conversion_target_missing" }, 409);
  }

  const job = await getJob(env, conversion.target_tenant_id, conversion.id);
  if (!job) return json({ error: "conversion_provisioning_job_not_found" }, 404);

  if (
    new Set(["provisioning", "ready"]).has(conversion.state)
    && job.node_id === input.node_id
    && new Set(["placed", "dispatched", "running", "ready"]).has(job.state)
  ) {
    return json({ conversion, provisioning_job: job, idempotent_replay: true });
  }

  if (conversion.state !== "approved") {
    return json({
      error: "invalid_conversion_transition",
      from_state: conversion.state,
      to_state: "provisioning",
    }, 409);
  }
  if (job.pool !== PRODUCTION_POOL || job.state !== "queued" || job.node_id !== null) {
    return json({ error: "production_job_not_placeable" }, 409);
  }

  const targetTenant = await env.DB.prepare(
    `SELECT id, sector, environment_kind, status, assigned_node_id
       FROM tenants
      WHERE id = ?`,
  ).bind(conversion.target_tenant_id).first<TenantRow>();
  if (!targetTenant || targetTenant.environment_kind !== "production") {
    return json({ error: "production_target_invalid" }, 409);
  }
  if (targetTenant.status !== "pending" || targetTenant.assigned_node_id !== null) {
    return json({ error: "production_target_not_placeable" }, 409);
  }

  const template = await env.DB.prepare(
    `SELECT id, sector, required_role, min_memory_mb, min_disk_gb
       FROM provisioning_templates
      WHERE id = ? AND active = 1`,
  ).bind(job.template_id).first<TemplateRow>();
  if (!template || template.sector !== targetTenant.sector) {
    return json({ error: "production_template_invalid" }, 409);
  }

  const node = await env.DB.prepare(
    `SELECT n.id, n.lifecycle_state, n.role, n.pool, n.last_seen_at, n.max_tenants,
            n.reserved_memory_mb, n.reserved_disk_gb, n.metrics,
            COUNT(t.id) AS tenant_count
       FROM nodes n
       LEFT JOIN tenants t
         ON t.assigned_node_id = n.id
        AND t.status <> 'decommissioned'
      WHERE n.id = ?
      GROUP BY n.id, n.lifecycle_state, n.role, n.pool, n.last_seen_at, n.max_tenants,
               n.reserved_memory_mb, n.reserved_disk_gb, n.metrics`,
  ).bind(input.node_id).first<NodePlacementRow>();
  if (!node) return json({ error: "production_node_not_found" }, 404);

  const offlineSeconds = Math.max(120, Number(env.NODE_OFFLINE_SECONDS || 300));
  const eligible = selectPlacementNode(
    [{ ...node, tenant_count: Number(node.tenant_count || 0) }],
    {
      required_role: template.required_role,
      min_memory_mb: template.min_memory_mb,
      min_disk_gb: template.min_disk_gb,
      pool: PRODUCTION_POOL,
    },
    Date.now(),
    offlineSeconds,
  );
  if (!eligible || eligible.id !== input.node_id) {
    return json({ error: "production_node_not_eligible" }, 409);
  }

  const now = nowIso();
  const payload = JSON.stringify({
    conversion_id: conversion.id,
    target_tenant_id: targetTenant.id,
    provisioning_job_id: job.id,
    node_id: input.node_id,
    pool: PRODUCTION_POOL,
  });

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE provisioning_jobs
          SET node_id = ?, state = 'placed', updated_at = ?
        WHERE id = ? AND state = 'queued' AND node_id IS NULL AND pool = ?`,
    ).bind(input.node_id, now, job.id, PRODUCTION_POOL),
    env.DB.prepare(
      `UPDATE tenants
          SET assigned_node_id = ?, status = 'provisioning', updated_at = ?
        WHERE id = ? AND environment_kind = 'production' AND status = 'pending'`,
    ).bind(input.node_id, now, targetTenant.id),
    env.DB.prepare(
      `UPDATE trial_conversion_requests
          SET state = 'provisioning', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND state = 'approved'`,
    ).bind(now, now, conversion.id),
    env.DB.prepare(
      `INSERT INTO provisioning_job_events
        (id, job_id, event_type, from_state, to_state, payload, created_at)
       VALUES (?, ?, 'conversion.production.placed', 'queued', 'placed', ?, ?)`,
    ).bind(crypto.randomUUID(), job.id, payload, now),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'trial.conversion.production_placed', 'admin', NULL,
               'trial_conversion', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), conversion.id, payload, now),
  ]);

  const placedConversion = await getConversion(env, trialTenantId, conversion.id);
  const placedJob = await getJob(env, targetTenant.id, conversion.id);

  return json({
    conversion: placedConversion,
    provisioning_job: placedJob,
    idempotent_replay: false,
    execution_gate: "production_job_placed",
  }, 201);
}

export async function handleProductionPlacementAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/v1\/admin\/trials\/([0-9a-f-]+)\/conversions\/([0-9a-f-]+)\/place-production$/i,
  );
  if (!match) return null;

  if (request.method === "POST") {
    return await placeProduction(request, env, match[1], match[2]);
  }
  return json({ error: "method_not_allowed" }, 405);
}
