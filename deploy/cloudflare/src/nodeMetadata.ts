export type NodeMetadataInput = {
  role?: unknown;
  pool?: unknown;
  labels?: unknown;
  max_tenants?: unknown;
  reserved_memory_mb?: unknown;
  reserved_disk_gb?: unknown;
};

export type NodeMetadata = {
  role: string;
  pool: string;
  labels: Record<string, string>;
  max_tenants: number | null;
  reserved_memory_mb: number;
  reserved_disk_gb: number;
};

const ROLES = new Set(["odoo-postgres", "odoo", "postgresql"]);
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_LABEL_KEY = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

function boundedInteger(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error("invalid_capacity_value");
  }
  return number;
}

function parseLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_labels");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new Error("too_many_labels");

  const labels: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase();
    const labelValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!SAFE_LABEL_KEY.test(key) || !labelValue || labelValue.length > 120) {
      throw new Error("invalid_label");
    }
    labels[key] = labelValue;
  }
  return labels;
}

export function parseNodeMetadata(input: NodeMetadataInput): NodeMetadata {
  const role = typeof input.role === "string" ? input.role.trim().toLowerCase() : "odoo-postgres";
  if (!ROLES.has(role)) throw new Error("invalid_role");

  const pool = typeof input.pool === "string" ? input.pool.trim().toLowerCase() : "default";
  if (!SAFE_NAME.test(pool)) throw new Error("invalid_pool");

  const maxTenants = boundedInteger(input.max_tenants, 1, 10000);
  const reservedMemory = boundedInteger(input.reserved_memory_mb, 0, 1048576) ?? 0;
  const reservedDisk = boundedInteger(input.reserved_disk_gb, 0, 1048576) ?? 0;

  return {
    role,
    pool,
    labels: parseLabels(input.labels),
    max_tenants: maxTenants,
    reserved_memory_mb: reservedMemory,
    reserved_disk_gb: reservedDisk,
  };
}
