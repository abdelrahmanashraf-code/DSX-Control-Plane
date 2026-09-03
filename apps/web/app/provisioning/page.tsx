import { AdminShell } from "../admin-shell";
import { field, getOperationsData, type JsonRecord } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

type Activity = {
  kind: "Provisioning" | "Backup" | "Restore";
  record: JsonRecord;
};

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

function activityTime(activity: Activity): number {
  const value = field(activity.record, "updated_at", field(activity.record, "created_at", ""));
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function operationTarget(activity: Activity): string {
  if (activity.kind === "Provisioning") return field(activity.record, "template_id");
  return field(activity.record, "database_name", field(activity.record, "backup_job_id"));
}

export default async function ProvisioningPage() {
  const data = await getOperationsData();
  const all: Activity[] = [
    ...data.provisioningJobs.map((record) => ({ kind: "Provisioning" as const, record })),
    ...data.backupJobs.map((record) => ({ kind: "Backup" as const, record })),
    ...data.restoreJobs.map((record) => ({ kind: "Restore" as const, record })),
  ].sort((left, right) => activityTime(right) - activityTime(left));

  const counts = {
    provisioning: data.provisioningJobs.length,
    active: data.provisioningJobs.filter((job) => ["queued", "placed", "dispatched", "running", "retrying"].includes(field(job, "state", ""))).length,
    failed: all.filter((activity) => field(activity.record, "state", "") === "failed").length,
    verifiedBackups: data.backupJobs.filter((job) => field(job, "state", "") === "verified").length,
    validatedRestores: data.restoreJobs.filter((job) => field(job, "state", "") === "validated").length,
  };

  return (
    <AdminShell active="provisioning">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHASE 5 / OPERATIONS</p>
          <h1>العمليات</h1>
          <p className="subtitle">
            Timeline موحد للـProvisioning والنسخ الاحتياطية والاستعادة. الهدف متابعة التشغيل اليومي من الواجهة بدل curl.
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
          تعذر قراءة العمليات: <code>{data.error}</code>
        </div>
      )}

      <section className="metrics" aria-label="ملخص العمليات">
        <article className="metric-card">
          <div className="metric-title">Provisioning</div>
          <div className="metric-value">{counts.provisioning.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Active {counts.active.toLocaleString("ar-EG")}</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Verified Backups</div>
          <div className="metric-value">{counts.verifiedBackups.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Verified artifacts</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Validated Restores</div>
          <div className="metric-value">{counts.validatedRestores.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Restore validation complete</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">Failed</div>
          <div className="metric-value">{counts.failed.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Across all operation types</div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">ACTIVITY</p>
            <h2>آخر العمليات</h2>
          </div>
          <span className="muted">{all.length.toLocaleString("ar-EG")} عملية</span>
        </div>

        <div className="table-wrap">
          <table className="operations-table">
            <thead>
              <tr>
                <th>النوع</th>
                <th>الحالة</th>
                <th>Tenant</th>
                <th>Node</th>
                <th>الهدف</th>
                <th>المحاولة</th>
                <th>الخطأ</th>
                <th>آخر تحديث</th>
              </tr>
            </thead>
            <tbody>
              {all.length === 0 ? (
                <tr><td colSpan={8} className="empty">لا توجد عمليات حتى الآن.</td></tr>
              ) : (
                all.slice(0, 300).map((activity) => (
                  <tr key={`${activity.kind}:${field(activity.record, "id")}`}>
                    <td><strong>{activity.kind}</strong></td>
                    <td><StatusPill value={field(activity.record, "state")} /></td>
                    <td><code>{field(activity.record, "tenant_id")}</code></td>
                    <td><code>{field(activity.record, "node_id")}</code></td>
                    <td><code>{operationTarget(activity)}</code></td>
                    <td>{field(activity.record, "attempt", "0")}</td>
                    <td><code>{field(activity.record, "error_code")}</code></td>
                    <td>{dateTime(field(activity.record, "updated_at", field(activity.record, "created_at")))}</td>
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
