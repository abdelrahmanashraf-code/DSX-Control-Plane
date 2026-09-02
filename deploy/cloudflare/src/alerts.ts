import { edgeJson, isEdgeAdmin, parseJsonObject } from "./edgeAdmin";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
}

type NodeAlertRow = {
  id: string;
  name: string;
  last_seen_at: string | null;
  metrics: string;
};

export type OperationalAlert = {
  node_id: string;
  node_name: string;
  severity: "warning" | "critical";
  code: string;
  value?: number | boolean | string | null;
  last_seen_at: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function metricHealthAlerts(row: NodeAlertRow, metrics: Record<string, unknown>): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const base = {
    node_id: row.id,
    node_name: row.name,
    last_seen_at: row.last_seen_at,
  };

  const disk = numberValue(metrics.disk_percent);
  if (disk !== null && disk >= 90) {
    alerts.push({ ...base, severity: "critical", code: "disk_usage_critical", value: disk });
  } else if (disk !== null && disk >= 80) {
    alerts.push({ ...base, severity: "warning", code: "disk_usage_high", value: disk });
  }

  const memory = numberValue(metrics.memory_percent);
  if (memory !== null && memory >= 95) {
    alerts.push({ ...base, severity: "critical", code: "memory_usage_critical", value: memory });
  } else if (memory !== null && memory >= 90) {
    alerts.push({ ...base, severity: "warning", code: "memory_usage_high", value: memory });
  }

  const cpu = numberValue(metrics.cpu_percent);
  if (cpu !== null && cpu >= 95) {
    alerts.push({ ...base, severity: "warning", code: "cpu_usage_high", value: cpu });
  }

  const services = objectValue(metrics.services);
  const odoo = objectValue(services.odoo);
  const postgresql = objectValue(services.postgresql);
  const odooRunning = boolValue(odoo.running);
  const postgresqlRunning = boolValue(postgresql.running);

  if (odooRunning === false) {
    alerts.push({ ...base, severity: "critical", code: "odoo_not_running", value: false });
  }
  if (postgresqlRunning === false) {
    alerts.push({
      ...base,
      severity: "critical",
      code: "postgresql_not_running",
      value: false,
    });
  }

  return alerts;
}

export function buildNodeAlerts(
  row: NodeAlertRow,
  nowMs: number,
  staleSeconds: number,
  offlineSeconds: number,
): OperationalAlert[] {
  const base = {
    node_id: row.id,
    node_name: row.name,
    last_seen_at: row.last_seen_at,
  };

  if (!row.last_seen_at) {
    return [{ ...base, severity: "warning", code: "node_never_seen" }];
  }

  const lastSeenMs = new Date(row.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs)) {
    return [{ ...base, severity: "warning", code: "node_last_seen_invalid" }];
  }

  const ageSeconds = Math.max(0, (nowMs - lastSeenMs) / 1000);
  const availabilityAlerts: OperationalAlert[] = [];
  if (ageSeconds > offlineSeconds) {
    availabilityAlerts.push({
      ...base,
      severity: "critical",
      code: "node_offline",
      value: Math.round(ageSeconds),
    });
  } else if (ageSeconds > staleSeconds) {
    availabilityAlerts.push({
      ...base,
      severity: "warning",
      code: "node_stale",
      value: Math.round(ageSeconds),
    });
  }

  const metrics = parseJsonObject(row.metrics);
  return [...availabilityAlerts, ...metricHealthAlerts(row, metrics)];
}

export async function listOperationalAlerts(request: Request, env: Env): Promise<Response> {
  if (!(await isEdgeAdmin(request, env))) return edgeJson({ error: "unauthorized" }, 401);

  const staleSeconds = Math.max(30, Number(env.NODE_STALE_SECONDS || 90));
  const offlineSeconds = Math.max(
    staleSeconds + 30,
    Number(env.NODE_OFFLINE_SECONDS || 300),
  );
  const result = await env.DB.prepare(
    `SELECT id, name, last_seen_at, metrics
       FROM nodes
      WHERE lifecycle_state = 'active'
      ORDER BY name
      LIMIT 500`,
  ).all<NodeAlertRow>();

  const nowMs = Date.now();
  const alerts = result.results.flatMap((row) =>
    buildNodeAlerts(row, nowMs, staleSeconds, offlineSeconds),
  );
  const rank = { critical: 0, warning: 1 } as const;
  alerts.sort((left, right) => rank[left.severity] - rank[right.severity]);

  return edgeJson({
    generated_at: new Date(nowMs).toISOString(),
    summary: {
      critical: alerts.filter((alert) => alert.severity === "critical").length,
      warning: alerts.filter((alert) => alert.severity === "warning").length,
      total: alerts.length,
    },
    alerts,
  });
}
