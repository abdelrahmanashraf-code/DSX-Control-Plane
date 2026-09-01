import { Client } from "pg";

interface Env {
  HYPERDRIVE: { connectionString: string };
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
}

type JsonObject = Record<string, unknown>;

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

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const supplied = bearerToken(request);
  if (!supplied || !env.ADMIN_API_TOKEN) return false;
  return (await sha256(supplied)) === (await sha256(env.ADMIN_API_TOKEN));
}

async function withDb<T>(env: Env, callback: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function audit(
  client: Client,
  eventType: string,
  actorType: string,
  actorId: string | null,
  targetType: string,
  targetId: string | null,
  payload: JsonObject = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, event_type, actor_type, actor_id, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [crypto.randomUUID(), eventType, actorType, actorId, targetType, targetId, JSON.stringify(payload)],
  );
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

  const result = await withDb(env, async (client) => {
    const inserted = await client.query(
      `INSERT INTO node_enrollment_tokens
         (id, token_hash, requested_name, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 minute'))
       RETURNING expires_at`,
      [id, tokenHash, requestedName, ttlMinutes],
    );
    await audit(client, "node.enrollment_token.created", "admin", "admin-api", "enrollment_token", id, {
      requested_name: requestedName,
      ttl_minutes: ttlMinutes,
    });
    return inserted.rows[0];
  });

  return json(
    {
      enrollment_token: token,
      expires_at: result.expires_at,
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

  try {
    await withDb(env, async (client) => {
      await client.query("BEGIN");
      try {
        const tokenResult = await client.query(
          `SELECT id, requested_name, expires_at, used_at
             FROM node_enrollment_tokens
            WHERE token_hash = $1
            FOR UPDATE`,
          [enrollmentHash],
        );
        const tokenRow = tokenResult.rows[0];
        if (!tokenRow || tokenRow.used_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
          throw new Error("INVALID_ENROLLMENT_TOKEN");
        }
        if (
          tokenRow.requested_name &&
          String(tokenRow.requested_name).toLocaleLowerCase() !== name.toLocaleLowerCase()
        ) {
          throw new Error("NODE_NAME_MISMATCH");
        }

        await client.query(
          `INSERT INTO nodes
             (id, name, hostname, agent_version, agent_token_hash, lifecycle_state)
           VALUES ($1, $2, $3, $4, $5, 'active')`,
          [nodeId, name, hostname, agentVersion, agentTokenHash],
        );
        await client.query(
          `UPDATE node_enrollment_tokens SET used_at = NOW() WHERE id = $1`,
          [tokenRow.id],
        );
        await audit(client, "node.enrolled", "node", nodeId, "node", nodeId, {
          name,
          hostname,
          agent_version: agentVersion,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NODE_NAME_MISMATCH") {
      return json({ error: "node_name_mismatch" }, 409);
    }
    if (error instanceof Error && error.message === "INVALID_ENROLLMENT_TOKEN") {
      return json({ error: "invalid_or_expired_enrollment_token" }, 401);
    }
    throw error;
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
  if (JSON.stringify(metrics).length > 32768) {
    return json({ error: "metrics_payload_too_large" }, 413);
  }

  const tokenHash = await sha256(token);
  const accepted = await withDb(env, async (client) => {
    const nodeResult = await client.query(
      `SELECT id FROM nodes
        WHERE id = $1
          AND lifecycle_state = 'active'
          AND revoked_at IS NULL
          AND agent_token_hash = $2`,
      [nodeId, tokenHash],
    );
    if (!nodeResult.rows[0]) return false;

    await client.query(
      `UPDATE nodes
          SET hostname = $2,
              agent_version = $3,
              last_seen_at = NOW(),
              last_observed_at = $4,
              metrics = $5::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [nodeId, hostname, agentVersion, observedAt.toISOString(), JSON.stringify(metrics)],
    );
    return true;
  });

  if (!accepted) return json({ error: "invalid_or_revoked_agent" }, 401);
  return json({ status: "accepted", server_time: new Date().toISOString() });
}

function effectiveNodeStatus(row: Record<string, unknown>, env: Env): string {
  if (row.lifecycle_state === "revoked") return "revoked";
  if (!row.last_seen_at) return "never_seen";

  const staleSeconds = Math.max(30, Number(env.NODE_STALE_SECONDS || 90));
  const offlineSeconds = Math.max(staleSeconds + 30, Number(env.NODE_OFFLINE_SECONDS || 300));
  const ageSeconds = (Date.now() - new Date(String(row.last_seen_at)).getTime()) / 1000;
  if (ageSeconds <= staleSeconds) return "online";
  if (ageSeconds <= offlineSeconds) return "stale";
  return "offline";
}

async function listNodes(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const rows = await withDb(env, async (client) => {
    const result = await client.query(
      `SELECT id, name, hostname, agent_version, lifecycle_state,
              last_seen_at, last_observed_at, metrics, created_at, updated_at, revoked_at
         FROM nodes
        ORDER BY created_at DESC
        LIMIT 500`,
    );
    return result.rows;
  });

  return json({
    nodes: rows.map((row) => ({ ...row, status: effectiveNodeStatus(row, env) })),
  });
}

async function revokeNode(request: Request, env: Env, nodeId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);

  const changed = await withDb(env, async (client) => {
    const result = await client.query(
      `UPDATE nodes
          SET lifecycle_state = 'revoked', revoked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND lifecycle_state <> 'revoked'
        RETURNING id`,
      [nodeId],
    );
    if (!result.rows[0]) return false;
    await audit(client, "node.revoked", "admin", "admin-api", "node", nodeId);
    return true;
  });

  return changed ? json({ status: "revoked", node_id: nodeId }) : json({ error: "node_not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok", service: "dsx-control-plane-edge" });
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
