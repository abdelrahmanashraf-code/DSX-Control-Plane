import Link from "next/link";

import { AdminShell } from "./admin-shell";
import { field, getDashboardData } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

function MetricCard({ title, value, note }: { title: string; value: number; note: string }) {
  return (
    <article className="metric-card">
      <div className="metric-title">{title}</div>
      <div className="metric-value">{value.toLocaleString("ar-EG")}</div>
      <div className="metric-note">{note}</div>
    </article>
  );
}

function StatusPill({ value }: { value: string }) {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return <span className={`status-pill status-${safe}`}>{value || "—"}</span>;
}

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <AdminShell active="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">DSX ADMIN</p>
          <h1>لوحة التحكم</h1>
          <p className="subtitle">إدارة الـControl Plane من واجهة واحدة بدل أوامر الـTerminal اليومية.</p>
        </div>
        <div className={data.error ? "connection bad" : data.configured ? "connection good" : "connection idle"}>
          <span className="dot" />
          {data.error ? "Control Plane غير متاح" : data.configured ? "متصل بالـControl Plane" : "في انتظار الإعداد"}
        </div>
      </header>

      {!data.configured && (
        <div className="notice">
          أول نسخة من الواجهة جاهزة. اربط <code>CONTROL_PLANE_BASE_URL</code> و
          <code> CONTROL_PLANE_ADMIN_TOKEN</code> على سيرفر الويب لعرض الداتا الحقيقية. التوكن لا يصل للمتصفح.
        </div>
      )}

      {data.error && (
        <div className="notice danger">
          تعذر قراءة الـControl Plane: <code>{data.error}</code>. الواجهة فشلت بشكل مقفول ولم تعرض أي Secret.
        </div>
      )}

      <section className="metrics" aria-label="ملخص النظام">
        <MetricCard title="العملاء / Tenants" value={data.counts.tenants} note={`${data.counts.readyTenants} جاهز`} />
        <MetricCard title="التجارب / Trials" value={data.counts.trials} note="Phase 5" />
        <MetricCard title="السيرفرات / Nodes" value={data.counts.nodes} note="مسجلة في Control Plane" />
        <MetricCard title="التنبيهات" value={data.counts.alerts} note={`${data.counts.criticalAlerts} Critical`} />
        <MetricCard title="Provisioning" value={data.counts.provisioningJobs} note={`${data.counts.failedProvisioning} Failed`} />
        <MetricCard title="Verified Backups" value={data.counts.verifiedBackups} note="DB + Filestore" />
        <MetricCard title="Validated Restores" value={data.counts.validatedRestores} note="Restore safety gate" />
      </section>

      <div className="two-columns">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">TENANTS</p>
              <h2>أحدث العملاء والتجارب</h2>
            </div>
            <span className="muted">آخر 6</span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>النوع</th>
                  <th>القطاع</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {data.recentTenants.length === 0 ? (
                  <tr><td colSpan={4} className="empty">لا توجد بيانات معروضة حاليًا.</td></tr>
                ) : (
                  data.recentTenants.map((tenant) => (
                    <tr key={field(tenant, "id")}>
                      <td>
                        <strong>{field(tenant, "name")}</strong>
                        <small>{field(tenant, "slug")}</small>
                      </td>
                      <td>{field(tenant, "environment_kind")}</td>
                      <td>{field(tenant, "sector")}</td>
                      <td><StatusPill value={field(tenant, "status")} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">ALERTS</p>
              <h2>آخر التنبيهات</h2>
            </div>
            <span className="muted">Read only</span>
          </div>

          <div className="alert-list">
            {data.recentAlerts.length === 0 ? (
              <div className="empty-box">لا توجد تنبيهات معروضة حاليًا.</div>
            ) : (
              data.recentAlerts.map((alert, index) => (
                <article className="alert-row" key={`${field(alert, "id", "alert")}-${index}`}>
                  <div>
                    <strong>{field(alert, "code", field(alert, "alert_type", "Alert"))}</strong>
                    <p>{field(alert, "message", field(alert, "node_name", "Control Plane alert"))}</p>
                  </div>
                  <StatusPill value={field(alert, "severity")} />
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="phase-banner">
        <div>
          <p className="eyebrow">PHASE 5</p>
          <h2>Trial Automation</h2>
          <p>شاشة التجارب أصبحت جزءًا من لوحة الإدارة، والإنشاء يمر عبر Control Plane والـtrial pool فقط.</p>
        </div>
        <Link href="/trials" className="phase-action">فتح التجارب</Link>
      </section>
    </AdminShell>
  );
}
