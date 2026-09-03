import { AdminShell } from "../admin-shell";
import {
  field,
  getNodesData,
  nestedNumberField,
  numberField,
  type JsonRecord,
} from "@/lib/control-plane";

export const dynamic = "force-dynamic";

function StatusPill({ value }: { value: string }) {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return <span className={`status-pill status-${safe}`}>{value || "—"}</span>;
}

function dateTime(value: string): string {
  if (!value || value === "—") return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(parsed);
}

function gib(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

function slots(node: JsonRecord): number | null {
  const max = numberField(node, "max_tenants");
  const used = numberField(node, "tenant_count") || 0;
  if (max === null) return null;
  return Math.max(0, max - used);
}

function metric(
  node: JsonRecord,
  flatKey: string,
  groupKey?: string,
  nestedKey?: string,
): number | null {
  const flat = nestedNumberField(node, "metrics", flatKey);
  if (flat !== null || !groupKey || !nestedKey) return flat;

  const metricsValue = node.metrics;
  if (!metricsValue || typeof metricsValue !== "object" || Array.isArray(metricsValue)) return null;
  const group = (metricsValue as JsonRecord)[groupKey];
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const value = (group as JsonRecord)[nestedKey];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export default async function NodesPage() {
  const data = await getNodesData();
  const counts = {
    total: data.nodes.length,
    online: data.nodes.filter((node) => field(node, "status", "") === "online").length,
    attention: data.nodes.filter((node) => ["stale", "offline", "never_seen"].includes(field(node, "status", ""))).length,
    trial: data.nodes.filter((node) => field(node, "pool", "") === "trial").length,
    slots: data.nodes.reduce((sum, node) => sum + (slots(node) || 0), 0),
  };

  return (
    <AdminShell active="nodes">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHASE 5 / NODES</p>
          <h1>السيرفرات</h1>
          <p className="subtitle">
            متابعة حالة الـNodes والسعة المتاحة والـPool الحالي. الشاشة للمتابعة فقط ولا تنفذ Restart أو Deploy أو SSH.
          </p>
        </div>
        <div className={data.error ? "connection bad" : data.configured ? "connection good" : "connection idle"}>
          <span className="dot" />
          {data.error ? "Control Plane غير متاح" : data.configured ? "متصل بالـControl Plane" : "في انتظار الإعداد"}
        </div>
      </header>

      {!data.configured && (
        <div className="notice">
          اربط <code>CONTROL_PLANE_BASE_URL</code> و <code>CONTROL_PLANE_ADMIN_TOKEN</code> على سيرفر الويب.
        </div>
      )}

      {data.error && (
        <div className="notice danger">
          تعذر قراءة بيانات السيرفرات: <code>{data.error}</code>
        </div>
      )}

      <section className="metrics" aria-label="ملخص السيرفرات">
        <article className="metric-card">
          <div className="metric-title">كل السيرفرات</div>
          <div className="metric-value">{counts.total.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Registered nodes</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Online</div>
          <div className="metric-value">{counts.online.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Healthy heartbeat</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">تحتاج انتباه</div>
          <div className="metric-value">{counts.attention.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Stale / Offline / Never seen</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">أماكن متاحة</div>
          <div className="metric-value">{counts.slots.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Configured tenant slots · Trial nodes {counts.trial.toLocaleString("ar-EG")}</div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">NODE CAPACITY</p>
            <h2>الحالة والسعة</h2>
          </div>
          <span className="muted">قراءة مباشرة من آخر Heartbeat</span>
        </div>

        <div className="table-wrap">
          <table className="nodes-table">
            <thead>
              <tr>
                <th>السيرفر</th>
                <th>الحالة</th>
                <th>Role / Pool</th>
                <th>العملاء</th>
                <th>Memory متاح</th>
                <th>Disk متاح</th>
                <th>CPU</th>
                <th>آخر Heartbeat</th>
                <th>Agent</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.length === 0 ? (
                <tr><td colSpan={9} className="empty">لا توجد Nodes مسجلة حتى الآن.</td></tr>
              ) : (
                data.nodes.map((node) => {
                  const used = numberField(node, "tenant_count") || 0;
                  const max = numberField(node, "max_tenants");
                  const memory = metric(node, "memory_available_bytes", "memory", "available_bytes");
                  const disk = metric(node, "disk_free_bytes", "disk", "free_bytes");
                  const cpu = metric(node, "cpu_percent");
                  const freeSlots = slots(node);

                  return (
                    <tr key={field(node, "id")}>
                      <td>
                        <strong>{field(node, "name")}</strong>
                        <small>{field(node, "hostname")}</small>
                      </td>
                      <td><StatusPill value={field(node, "status")} /></td>
                      <td>
                        <strong>{field(node, "role")}</strong>
                        <small>{field(node, "pool")}</small>
                      </td>
                      <td>
                        <strong>{used.toLocaleString("ar-EG")} / {max === null ? "—" : max.toLocaleString("ar-EG")}</strong>
                        <small>{freeSlots === null ? "السعة غير محددة" : `${freeSlots.toLocaleString("ar-EG")} متاح`}</small>
                      </td>
                      <td>{gib(memory)}</td>
                      <td>{gib(disk)}</td>
                      <td>{cpu === null ? "—" : `${cpu.toFixed(0)}%`}</td>
                      <td>{dateTime(field(node, "last_seen_at"))}</td>
                      <td><code>{field(node, "agent_version")}</code></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
