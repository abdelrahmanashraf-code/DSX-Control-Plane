import { AdminShell } from "../admin-shell";
import { field, getTenantsData } from "@/lib/control-plane";

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

function environmentLabel(value: string): string {
  if (value === "production") return "Production";
  if (value === "trial") return "Trial";
  if (value === "test") return "Test";
  return value || "—";
}

export default async function TenantsPage() {
  const data = await getTenantsData();
  const counts = {
    total: data.tenants.length,
    production: data.tenants.filter((tenant) => field(tenant, "environment_kind", "") === "production").length,
    trial: data.tenants.filter((tenant) => field(tenant, "environment_kind", "") === "trial").length,
    ready: data.tenants.filter((tenant) => field(tenant, "status", "") === "ready").length,
    failed: data.tenants.filter((tenant) => field(tenant, "status", "") === "failed").length,
  };

  return (
    <AdminShell active="tenants">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHASE 5 / TENANTS</p>
          <h1>العملاء</h1>
          <p className="subtitle">
            نظرة موحدة على بيئات العملاء، نوع البيئة، حالة التشغيل، الـNode وقاعدة البيانات المسجلة في الـControl Plane.
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
          تعذر قراءة بيانات العملاء: <code>{data.error}</code>
        </div>
      )}

      <section className="metrics" aria-label="ملخص العملاء">
        <article className="metric-card">
          <div className="metric-title">كل العملاء</div>
          <div className="metric-value">{counts.total.toLocaleString("ar-EG")}</div>
          <div className="metric-note">All environments</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Production</div>
          <div className="metric-value">{counts.production.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Customer production environments</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Trial</div>
          <div className="metric-value">{counts.trial.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Disposable trial environments</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">جاهزة</div>
          <div className="metric-value">{counts.ready.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Ready · Failed {counts.failed.toLocaleString("ar-EG")}</div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">TENANT LIFECYCLE</p>
            <h2>البيئات المسجلة</h2>
          </div>
          <span className="muted">Source of truth: Control Plane</span>
        </div>

        <div className="table-wrap">
          <table className="tenants-table">
            <thead>
              <tr>
                <th>العميل</th>
                <th>القطاع</th>
                <th>البيئة</th>
                <th>الحالة</th>
                <th>Node</th>
                <th>قاعدة البيانات</th>
                <th>آخر تحديث</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.length === 0 ? (
                <tr><td colSpan={7} className="empty">لا توجد بيئات مسجلة حتى الآن.</td></tr>
              ) : (
                data.tenants.map((tenant) => (
                  <tr key={field(tenant, "id")}>
                    <td>
                      <strong>{field(tenant, "name")}</strong>
                      <small>{field(tenant, "slug")}</small>
                    </td>
                    <td>{field(tenant, "sector")}</td>
                    <td><StatusPill value={environmentLabel(field(tenant, "environment_kind", ""))} /></td>
                    <td><StatusPill value={field(tenant, "status")} /></td>
                    <td><code>{field(tenant, "assigned_node_id")}</code></td>
                    <td><code>{field(tenant, "database_name")}</code></td>
                    <td>{dateTime(field(tenant, "updated_at"))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
