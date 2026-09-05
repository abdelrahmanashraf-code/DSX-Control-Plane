import "server-only";

export type JsonRecord = Record<string, unknown>;

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

export type TrialsData = {
  configured: boolean;
  error: string | null;
  trials: JsonRecord[];
  conversionsByTrial: Record<string, JsonRecord[]>;
};

export type NodesData = {
  configured: boolean;
  error: string | null;
  nodes: JsonRecord[];
};

export type TenantsData = {
  configured: boolean;
  error: string | null;
  tenants: JsonRecord[];
};

export type OperationsData = {
  configured: boolean;
  error: string | null;
  provisioningJobs: JsonRecord[];
  backupJobs: JsonRecord[];
  restoreJobs: JsonRecord[];
};

export type CreateTrialInput = {
  name: string;
  slug: string;
  sector: "restaurant" | "cafe" | "retail" | "supermarket";
  idempotencyKey: string;
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

async function request(path: string, init?: RequestInit): Promise<JsonRecord> {
  const runtime = config();
  if (!runtime) throw new Error("control_plane_not_configured");

  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${runtime.token}`);
  headers.set("accept", "application/json");

  const response = await fetch(`${runtime.baseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = value && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonRecord).error === "string"
      ? (value as JsonRecord).error
      : `http_${response.status}`;
    throw new Error(`control_plane_${code}`);
  }

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

export async function getTrialsData(): Promise<TrialsData> {
  if (!config()) return { configured: false, error: null, trials: [], conversionsByTrial: {} };
  try {
    const [trialsPayload, tenantsPayload, provisioningPayload] = await Promise.all([
      request("/v1/admin/trials"),
      request("/v1/admin/tenants"),
      request("/v1/admin/provisioning-jobs"),
    ]);
    const trials = records(trialsPayload, "trials");
    const tenants = records(tenantsPayload, "tenants");
    const provisioningJobs = records(provisioningPayload, "jobs");
    const tenantById = new Map(tenants.map((tenant) => [text(tenant, "id"), tenant]));

    const conversionEntries = await Promise.all(
      trials.map(async (trial): Promise<[string, JsonRecord[]]> => {
        const trialId = text(trial, "id");
        if (!trialId) return ["", []];
        try {
          const payload = await request(`/v1/admin/trials/${encodeURIComponent(trialId)}/conversions`);
          const conversions = records(payload, "conversions").map((conversion) => {
            const conversionId = text(conversion, "id");
            const targetTenantId = text(conversion, "target_tenant_id");
            const targetTenant = targetTenantId ? tenantById.get(targetTenantId) ?? null : null;
            const provisioningJob = targetTenantId && conversionId
              ? provisioningJobs.find((job) =>
                text(job, "tenant_id") === targetTenantId
                && text(job, "idempotency_key") === `conversion:${conversionId}`,
              ) ?? null
              : null;
            return {
              ...conversion,
              target_tenant: targetTenant,
              provisioning_job: provisioningJob,
            };
          });
          return [trialId, conversions];
        } catch {
          return [trialId, []];
        }
      }),
    );

    return {
      configured: true,
      error: null,
      trials,
      conversionsByTrial: Object.fromEntries(conversionEntries.filter(([trialId]) => Boolean(trialId))),
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "control_plane_unavailable",
      trials: [],
      conversionsByTrial: {},
    };
  }
}

export async function getNodesData(): Promise<NodesData> {
  if (!config()) return { configured: false, error: null, nodes: [] };
  try {
    const [nodesPayload, tenantsPayload] = await Promise.all([
      request("/v1/admin/nodes"),
      request("/v1/admin/tenants"),
    ]);
    const nodes = records(nodesPayload, "nodes");
    const tenants = records(tenantsPayload, "tenants");
    const tenantCounts = new Map<string, number>();
    for (const tenant of tenants) {
      const nodeId = text(tenant, "assigned_node_id");
      if (!nodeId || text(tenant, "status") === "decommissioned") continue;
      tenantCounts.set(nodeId, (tenantCounts.get(nodeId) || 0) + 1);
    }
    return {
      configured: true,
      error: null,
      nodes: nodes.map((node) => ({
        ...node,
        tenant_count: tenantCounts.get(text(node, "id")) || 0,
      })),
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "control_plane_unavailable",
      nodes: [],
    };
  }
}

export async function getTenantsData(): Promise<TenantsData> {
  if (!config()) return { configured: false, error: null, tenants: [] };
  try {
    const payload = await request("/v1/admin/tenants");
    return { configured: true, error: null, tenants: records(payload, "tenants") };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "control_plane_unavailable",
      tenants: [],
    };
  }
}

export async function getOperationsData(): Promise<OperationsData> {
  if (!config()) {
    return { configured: false, error: null, provisioningJobs: [], backupJobs: [], restoreJobs: [] };
  }
  try {
    const [provisioningPayload, backupsPayload, restoresPayload] = await Promise.all([
      request("/v1/admin/provisioning-jobs"),
      request("/v1/admin/backup-jobs"),
      request("/v1/admin/restore-jobs"),
    ]);
    return {
      configured: true,
      error: null,
      provisioningJobs: records(provisioningPayload, "jobs"),
      backupJobs: records(backupsPayload, "backup_jobs"),
      restoreJobs: records(restoresPayload, "restore_jobs"),
    };
  } catch (error) {
    return {
      configured: true,
      error: error instanceof Error ? error.message : "control_plane_unavailable",
      provisioningJobs: [],
      backupJobs: [],
      restoreJobs: [],
    };
  }
}

export async function createTrial(input: CreateTrialInput): Promise<void> {
  if (!config()) throw new Error("control_plane_not_configured");
  await request("/v1/admin/trials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      sector: input.sector,
      idempotency_key: input.idempotencyKey,
    }),
  });
}

export async function retryTrialCleanup(tenantId: string): Promise<void> {
  if (!config()) throw new Error("control_plane_not_configured");
  await request(`/v1/admin/trials/${encodeURIComponent(tenantId)}/cleanup/retry`, {
    method: "POST",
  });
}

export async function requestTrialConversion(tenantId: string, idempotencyKey: string): Promise<void> {
  if (!config()) throw new Error("control_plane_not_configured");
  await request(`/v1/admin/trials/${encodeURIComponent(tenantId)}/conversions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      mode: "clean_production",
    }),
  });
}

export async function approveTrialConversion(
  tenantId: string,
  conversionId: string,
  productionName?: string,
  productionSlug?: string,
): Promise<void> {
  if (!config()) throw new Error("control_plane_not_configured");
  await request(
    `/v1/admin/trials/${encodeURIComponent(tenantId)}/conversions/${encodeURIComponent(conversionId)}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        production_name: productionName || undefined,
        production_slug: productionSlug || undefined,
      }),
    },
  );
}

export async function placeTrialProduction(
  tenantId: string,
  conversionId: string,
  nodeId: string,
): Promise<void> {
  if (!config()) throw new Error("control_plane_not_configured");
  await request(
    `/v1/admin/trials/${encodeURIComponent(tenantId)}/conversions/${encodeURIComponent(conversionId)}/place-production`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm_production_placement: true,
        node_id: nodeId,
      }),
    },
  );
}

export function field(record: JsonRecord, key: string, fallback = "—"): string {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function numberField(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nestedNumberField(record: JsonRecord, key: string, nestedKey: string): number | null {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as JsonRecord)[nestedKey];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}
