import { edgeJson, isEdgeAdmin } from "./edgeAdmin";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
}

type HealthSampleRow = {
  sampled_at: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_percent: number | null;
  odoo_running: number | null;
  postgresql_running: number | null;
  database_count: number | null;
};

export function parseHealthHistoryLimit(value: string | null): number {
  if (!value) return 72;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 72;
  return Math.max(1, Math.min(288, parsed));
}

export async function listNodeHealthHistory(
  request: Request,
  env: Env,
  nodeId: string,
): Promise<Response> {
  if (!(await isEdgeAdmin(request, env))) return edgeJson({ error: "unauthorized" }, 401);

  const node = await env.DB.prepare("SELECT id FROM nodes WHERE id = ? LIMIT 1")
    .bind(nodeId)
    .first<{ id: string }>();
  if (!node) return edgeJson({ error: "node_not_found" }, 404);

  const url = new URL(request.url);
  const limit = parseHealthHistoryLimit(url.searchParams.get("limit"));
  const result = await env.DB.prepare(
    `SELECT sampled_at, cpu_percent, memory_percent, disk_percent,
            odoo_running, postgresql_running, database_count
       FROM node_health_samples
      WHERE node_id = ?
      ORDER BY sampled_at DESC
      LIMIT ?`,
  )
    .bind(nodeId, limit)
    .all<HealthSampleRow>();

  return edgeJson({
    node_id: nodeId,
    sample_interval_seconds: 300,
    retention_days: 7,
    samples: result.results.map((row) => ({
      sampled_at: row.sampled_at,
      cpu_percent: row.cpu_percent,
      memory_percent: row.memory_percent,
      disk_percent: row.disk_percent,
      odoo_running: row.odoo_running === null ? null : Boolean(row.odoo_running),
      postgresql_running:
        row.postgresql_running === null ? null : Boolean(row.postgresql_running),
      database_count: row.database_count,
    })),
  });
}
