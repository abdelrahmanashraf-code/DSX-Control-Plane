interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type JsonObject = Record<string, unknown>;

export const DEFAULT_TRIAL_CONVERSION_MODE = "clean_production" as const;
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

type TrialRow = {
  id: string;
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

const encoder = new TextEncoder();
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

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

async function getConversionByRequestKey(env: Env, requestKey: string): Promise<ConversionRow | null> {
  return await env.DB.prepare(
    `SELECT id, trial_tenant_id, request_key, mode, state, target_tenant_id,
            promotion_confirmed_at, error_code, requested_at, updated_at, started_at, finished_at
       FROM trial_conversion_requests
      WHERE request_key = ?`,
  ).bind(requestKey).first<ConversionRow>();
}

async function listConversions(request: Request, env: Env, trialTenantId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const trial = await env.DB.prepare(
    `SELECT id, environment_kind, trial_state, database_name FROM tenants WHERE id = ?`,
  ).bind(trialTenantId).first<TrialRow>();
  if (!trial || trial.environment_kind !== "trial") return json({ error: "trial_not_found" }, 404);

  const rows = await env.DB.prepare(
    `SELECT id, trial_tenant_id, request_key, mode, state, target_tenant_id,
            promotion_confirmed_at, error_code, requested_at, updated_at, started_at, finished_at
       FROM trial_conversion_requests
      WHERE trial_tenant_id = ?
      ORDER BY requested_at DESC
      LIMIT 50`,
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
    `SELECT id, environment_kind, trial_state, database_name FROM tenants WHERE id = ?`,
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

export async function handleTrialConversionAdminRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/admin\/trials\/([0-9a-f-]+)\/conversions$/i);
  if (!match) return null;

  if (request.method === "GET") return await listConversions(request, env, match[1]);
  if (request.method === "POST") return await createConversion(request, env, match[1]);
  return json({ error: "method_not_allowed" }, 405);
}
