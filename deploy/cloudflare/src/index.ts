interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
}

type JsonObject = Record<string, unknown>;

type NodeRow = {
  id: string;
  name: string;
  hostname: string;
  agent_version: string;
  lifecycle_state: string;
  last_seen_at: string | null;
  last_observed_at: string | null;
  metrics: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type EnrollmentRow = {
  id: string;
  requested_name: string | null;
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

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const supplied = bearerToken(request);
  if (!supplied || !env.ADMIN_API_TOKEN) return false;
  return (await sha256(supplied)) === (await sha256(env.ADMIN_API_TOKEN));
}

async function audit(
  env: Env,
  eventType: string,
  actorType: string,
  actorId: string | null,
  targetType: string,
  targetId: string | null,
  payload: JsonObject = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
       (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      eventType,
      actorType,
      actorId,
      targetType,
      targetId,
      JSON.stringify(payload),
      nowIso(),
    )
    .run();
}

async function createEnrollmentToken(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const body = (await readJson(request)) || {};
  const requestedName = text(body.node_name, 120) || null;
  const rawTtl = Number(body.ttl_minutes ?? 15);
  const ttlMinutes = Number.isFinite(rawTtl) ? Math.max(5, Math.min(60, Math.trunc(rawTtl))) : 15;
  const token = randomSecret("dsx_enroll");
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO node_enrollment_tokens
         (id, token_hash, requested_name, created_at, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'admin-api')`,
    ).bind(id, tokenHash, requestedName, createdAt, expiresAt),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
       VALUES (?, 'node.enrollment_token.created', 'admin', 'admin-api', 'enrollment_token', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      id,
      JSON.stringify({ requested_name: requestedName, ttl_minutes: ttlMinutes }),
      createdAt,
    ),
  ]);

  return json(
    {
      enrollment_token: token,
      expires_at: expiresAt,
      node_name: requestedName,
      note: "This token is shown once and is valid for one enrollment only.",
    },
    201,
  );
}

async function enrollNode(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const enrollmentToken = text(body.enrollment_token, 256);
  const name = text(body.name, 120);
  const hostname = text(body.hostname, 255);
  const agentVersion = text(body.agent_version, 64);
  if (!enrollmentToken || !name || !hostname || !agentVersion) {
    return json({ error: "missing_required_fields" }, 400);
  }

  const enrollmentHash = await sha256(enrollmentToken);
  const nodeId = crypto.randomUUID();
  const agentToken = randomSecret("dsx_agent");
  const agentTokenHash = await sha256(agentToken);
  const enrolledAt = nowIso();

  const consumed = await env.DB.prepare(
    `UPDATE node_enrollment_tokens
        SET used_at = ?
      WHERE token_hash = ?
        AND used_at IS NULL
        AND expires_at > ?
        AND (requested_name IS NULL OR lower(requested_name) = lower(?))
      RETURNING id, requested_name`,
  )
    .bind(enrolledAt, enrollmentHash, enrolledAt, name)
    .first<EnrollmentRow>();

  if (!consumed) {
    return json({ error: "invalid_expired_or_name_mismatched_enrollment_token" }, 401);
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO nodes
           (id, name, hostname, agent_version, agent_token_hash, lifecycle_state,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(nodeId, name, hostname, agentVersion, agentTokenHash, enrolledAt, enrolledAt),
      env.DB.prepare(
        `INSERT INTO audit_events
           (id, event_type, actor_type, actor_id, target_type, target_id, payload, created_at)
         VALUES (?, 'node.enrolled', 'node', ?, 'node', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        nodeId,
        nodeId,
        JSON.stringify({ name, hostname, agent_version: agentVersion }),
        enrolledAt,
      ),
    ]);
  } catch (error) {
    console.error("Node enrollment persistence failed after token consumption", error);
    return json({ error: "enrollment_persistence_failed_request_new_token" }, 500);
  }

  return json(
    {
      node_id: nodeId,
      agent_token: agentToken,
      note: "Store this credential securely. It cannot be recovered from the Control Plane.",
    },
    201,
  );
}

function parseObservedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function heartbeat(request: Request, env: Env, nodeId: string): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: "unauthorized" }, 401);

  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const observedAt = parseObservedAt(body.observed_at);
  const hostname = text(body.hostname, 255);
  const agentVersion = text(body.agent_version, 64);
  const metrics = body.metrics;
  if (!observedAt || !hostname || !agentVersion || !metrics || typeof metrics !== "object") {
    return json({ error: "invalid_heartbeat" }, 400);
  }

  const metricsJson = JSON.stringify(metrics);
  if (metricsJson.length > 32768) {
    return json({ error: "metrics_payload_too_large" }, 413);
  }

  const tokenHash = await sha256(token);
  const receivedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE nodes
        SET hostname = ?,
            agent_version = ?,
            last_seen_at = ?,
            last_observed_at = ?,
            metrics = ?,
            updated_at = ?
      WHERE id = ?
        AND lifecycle_state = 'active'
        AND revoked_at IS NULL
        AND agent_token_hash = ?`,
  )
    .bind(
      hostname,
      agentVersion,
      receivedAt,
      observedAt.toISOString(),
      metricsJson,
      receivedAt,
      nodeId,
      tokenHash,
    )
    .run();

  if (!result.meta.changes) return json({ error: "invalid_or_revoked_agent" }, 401);
  return json({ status: "accepted", server_time: receivedAt });
}

function effectiveNodeStatus(row: NodeRow, env: Env): string {
  if (row.lifecycle_state === "revoked") return "revoked";
  if (!row.last_seen_at) return "never_seen";

  const staleSeconds = Math.max(30, Number(env.NODE_STALE_SECONDS || 90));
  const offlineSeconds = Math.max(staleSeconds + 30, Number(env.NODE_OFFLINE_SECONDS || 300));
  const ageSeconds = (Date.now() - new Date(row.last_seen_at).getTime()) / 1000;
  if (ageSeconds <= staleSeconds) return "online";
  if (ageSeconds <= offlineSeconds) return "stale";
  return "offline";
}

function parseMetrics(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

async function listNodes(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const result = await env.DB.prepare(
    `SELECT id, name, hostname, agent_version, lifecycle_state,
            last_seen_at, last_observed_at, metrics, created_at, updated_at, revoked_at
       FROM nodes
      ORDER BY created_at DESC
      LIMIT 500`,
  ).all<NodeRow>();

  return json({
    nodes: result.results.map((row) => ({
      ...row,
      metrics: parseMetrics(row.metrics),
      status: effectiveNodeStatus(row, env),
    })),
  });
}

async function revokeNode(request: Request, env: Env, nodeId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const revokedAt = nowIso();
  const result = await env.DB.prepare(
    `UPDATE nodes
        SET lifecycle_state = 'revoked', revoked_at = ?, updated_at = ?
      WHERE id = ? AND lifecycle_state <> 'revoked'`,
  )
    .bind(revokedAt, revokedAt, nodeId)
    .run();

  if (!result.meta.changes) return json({ error: "node_not_found" }, 404);
  await audit(env, "node.revoked", "admin", "admin-api", "node", nodeId);
  return json({ status: "revoked", node_id: nodeId });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok", service: "dsx-control-plane-edge", storage: "d1" });
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/enrollment-tokens") {
        return await createEnrollmentToken(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/nodes/enroll") {
        return await enrollNode(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/nodes") {
        return await listNodes(request, env);
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/nodes\/([0-9a-f-]+)\/heartbeat$/i);
      if (request.method === "POST" && heartbeatMatch) {
        return await heartbeat(request, env, heartbeatMatch[1]);
      }

      const revokeMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([0-9a-f-]+)\/revoke$/i);
      if (request.method === "POST" && revokeMatch) {
        return await revokeNode(request, env, revokeMatch[1]);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("Unhandled DSX edge error", error);
      return json({ error: "internal_error" }, 500);
    }
  },
};
