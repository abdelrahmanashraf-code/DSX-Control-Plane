import "server-only";

type JsonRecord = Record<string, unknown>;

export type DashboardData = {
  configured: boolean;
  error: string | null;
  counts: {
    tenants: number;
    trials: number;
    readyTenants: number;
    nodes: number;
    alerts: number;
    criticalAlerts: number;
    provisioningJobs: number;
    failedProvisioning: number;
    verifiedBackups: number;
    validatedRestores: number;
  };
  recentTenants: JsonRecord[];
  recentAlerts: JsonRecord[];
};

const EMPTY_COUNTS: DashboardData["counts"] = {
  tenants: 0,
  trials: 0,
  readyTenants: 0,
  nodes: 0,
  alerts: 0,
  criticalAlerts: 0,
  provisioningJobs: 0,
  failedProvisioning: 0,
  verifiedBackups: 0,
  validatedRestores: 0,
};

function config(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.CONTROL_PLANE_BASE_URL?.trim().replace(/\/$/, "");
  const token = process.env.CONTROL_PLANE_ADMIN_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function request(path: string): Promise<JsonRecord> {
  const runtime = config();
  if (!runtime) throw new Error("control_plane_not_configured");

  const response = await fetch(`${runtime.baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${runtime.token}`,
      accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`control_plane_http_${response.status}`);
  }

  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control_plane_invalid_json");
  }
  return value as JsonRecord;
}

function records(payload: JsonRecord, key: string): JsonRecord[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function text(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export async function getDashboardData(): Promise<DashboardData> {
  if (!config()) {
    return {
      configured: false,
      error: null,
      counts: EMPTY_COUNTS,
      recentTenants: [],
      recentAlerts: [],
    };
  }

  try {
    const [tenantsPayload, nodesPayload, alertsPayload, provisioningPayload, backupsPayload, restoresPayload] =
      await Promise.all([
        request("/v1/admin/tenants"),
        request("/v1/admin/nodes"),
        request("/v1/admin/alerts"),
        request("/v1/admin/provisioning-jobs"),
        request("/v1/admin/backup-jobs"),
        request("/v1/admin/restore-jobs"),
      ]);

    const tenants = records(tenantsPayload, "tenants");
    const nodes = records(nodesPayload, "nodes");
    const alerts = records(alertsPayload, "alerts");
    const provisioningJobs = records(provisioningPayload, "jobs");
    const backups = records(backupsPayload, "backup_jobs");
    const restores = records(restoresPayload, "restore_jobs");

    return {
      configured: true,
      error: null,
      counts: {
        tenants: tenants.length,
        trials: tenants.filter((tenant) => text(tenant, "environment_kind") === "trial").length,
        readyTenants: tenants.filter((tenant) => text(tenant, "status") === "ready").length,
        nodes: nodes.length,
        alerts: alerts.length,
        criticalAlerts: alerts.filter((alert) => text(alert, "severity") === "critical").length,
        provisioningJobs: provisioningJobs.length,
        failedProvisioning: provisioningJobs.filter((job) => text(job, "state") === "failed").length,
        verifiedBackups: backups.filter((job) => text(job, "state") === "verified").length,
        validatedRestores: restores.filter((job) => text(job, "state") === "validated").length,
      },
      recentTenants: tenants.slice(0, 6),
      recentAlerts: alerts.slice(0, 5),
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "control_plane_unavailable",
      counts: EMPTY_COUNTS,
      recentTenants: [],
      recentAlerts: [],
    };
  }
}

export function field(record: JsonRecord, key: string, fallback = "—"): string {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
