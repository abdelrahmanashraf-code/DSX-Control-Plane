import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AdminShell } from "../admin-shell";
import { createTrial, field, getTrialsData, retryTrialCleanup } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

const SECTORS = [
  ["restaurant", "مطعم"],
  ["cafe", "كافيه"],
  ["retail", "محلات / Retail"],
  ["supermarket", "سوبر ماركت"],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function createTrialAction(formData: FormData) {
  "use server";

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const sector = String(formData.get("sector") ?? "").trim().toLowerCase();
  const allowedSectors = new Set(SECTORS.map(([value]) => value));

  if (!name || !slug || !allowedSectors.has(sector as (typeof SECTORS)[number][0])) {
    redirect("/trials?error=invalid_form");
  }

  try {
    await createTrial({
      name,
      slug,
      sector: sector as "restaurant" | "cafe" | "retail" | "supermarket",
      idempotencyKey: `admin:${crypto.randomUUID()}`,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "control_plane_unavailable";
    redirect(`/trials?error=${encodeURIComponent(code)}`);
  }

  revalidatePath("/");
  revalidatePath("/trials");
  redirect("/trials?created=1");
}

async function retryCleanupAction(formData: FormData) {
  "use server";

  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  if (!UUID.test(tenantId)) redirect("/trials?error=invalid_trial_id");

  try {
    await retryTrialCleanup(tenantId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "control_plane_unavailable";
    redirect(`/trials?error=${encodeURIComponent(code)}`);
  }

  revalidatePath("/");
  revalidatePath("/trials");
  redirect("/trials?retried=1");
}

type TrialsPageProps = {
  searchParams: Promise<{ created?: string; retried?: string; error?: string }>;
};

export default async function TrialsPage({ searchParams }: TrialsPageProps) {
  const [data, params] = await Promise.all([getTrialsData(), searchParams]);
  const counts = {
    total: data.trials.length,
    active: data.trials.filter((trial) => field(trial, "trial_state", "") === "active").length,
    provisioning: data.trials.filter((trial) => field(trial, "trial_state", "") === "provisioning").length,
    failed: data.trials.filter((trial) => field(trial, "trial_state", "") === "failed").length,
  };

  return (
    <AdminShell active="trials">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHASE 5 / TRIALS</p>
          <h1>التجارب</h1>
          <p className="subtitle">
            إنشاء ومتابعة تجارب Odoo لمدة 3 أيام. المدة تبدأ بعد وصول البيئة لحالة Ready.
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
          بيانات الاعتماد لا تصل للمتصفح.
        </div>
      )}

      {data.error && (
        <div className="notice danger">
          تعذر قراءة التجارب: <code>{data.error}</code>
        </div>
      )}

      {params.created === "1" && (
        <div className="notice success">تم تسجيل طلب التجربة وإرساله تلقائيًا لمسار الـProvisioning.</div>
      )}

      {params.retried === "1" && (
        <div className="notice success">تمت إعادة محاولة تنظيف التجربة بأمان.</div>
      )}

      {params.error && (
        <div className="notice danger">
          تعذر تنفيذ الطلب: <code>{params.error}</code>
        </div>
      )}

      <section className="metrics trial-metrics" aria-label="ملخص التجارب">
        <article className="metric-card">
          <div className="metric-title">كل التجارب</div>
          <div className="metric-value">{counts.total.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Trial environments</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">نشطة</div>
          <div className="metric-value">{counts.active.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Active</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">جاري الإنشاء</div>
          <div className="metric-value">{counts.provisioning.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Provisioning</div>
        </article>
        <article className="metric-card">
          <div className="metric-title">تحتاج مراجعة</div>
          <div className="metric-value">{counts.failed.toLocaleString("ar-EG")}</div>
          <div className="metric-note">Failed</div>
        </article>
      </section>

      <div className="trial-layout">
        <section className="panel trial-create-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">CREATE TRIAL</p>
              <h2>إنشاء تجربة جديدة</h2>
            </div>
            <span className="muted">3 أيام من Ready</span>
          </div>

          <form action={createTrialAction} className="trial-form">
            <label>
              <span>اسم العميل / الشركة</span>
              <input name="name" type="text" maxLength={120} required placeholder="مثال: مطعم التجربة" />
            </label>

            <label>
              <span>Slug</span>
              <input
                name="slug"
                type="text"
                minLength={2}
                maxLength={64}
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                dir="ltr"
                required
                placeholder="demo-restaurant"
              />
              <small>حروف إنجليزية صغيرة وأرقام وشرطة فقط.</small>
            </label>

            <label>
              <span>القطاع</span>
              <select name="sector" defaultValue="restaurant" required>
                {SECTORS.map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </label>

            <div className="trial-form-note">
              النظام يختار الـGolden Template المناسب والـNode من <code>trial</code> pool فقط، ثم يبدأ الـProvisioning تلقائيًا.
            </div>

            <button type="submit" className="primary-button" disabled={!data.configured || Boolean(data.error)}>
              إنشاء تجربة 3 أيام
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">TRIAL LIFECYCLE</p>
              <h2>التجارب الحالية</h2>
            </div>
            <span className="muted">{counts.total.toLocaleString("ar-EG")} إجمالي</span>
          </div>

          <div className="table-wrap">
            <table className="trials-table">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>القطاع</th>
                  <th>الحالة</th>
                  <th>التنظيف</th>
                  <th>قاعدة البيانات</th>
                  <th>الدومين</th>
                  <th>بدأت</th>
                  <th>تنتهي</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {data.trials.length === 0 ? (
                  <tr><td colSpan={9} className="empty">لا توجد تجارب حتى الآن.</td></tr>
                ) : (
                  data.trials.map((trial) => {
                    const tenantId = field(trial, "id", "");
                    const trialState = field(trial, "trial_state", field(trial, "status"));
                    const cleanupState = field(trial, "cleanup_state", "");
                    const cleanupError = field(trial, "cleanup_error_code", "");
                    const canRetry = trialState === "failed" && cleanupState === "failed" && UUID.test(tenantId);
                    const expiredAt = field(trial, "trial_expired_at", "");

                    return (
                      <tr key={tenantId}>
                        <td>
                          <strong>{field(trial, "name")}</strong>
                          <small>{field(trial, "slug")}</small>
                        </td>
                        <td>{field(trial, "sector")}</td>
                        <td><StatusPill value={trialState} /></td>
                        <td className="cleanup-cell">
                          {cleanupState ? <StatusPill value={cleanupState} /> : <span className="muted">—</span>}
                          {cleanupError && <small>{cleanupError}</small>}
                        </td>
                        <td><code>{field(trial, "database_name")}</code></td>
                        <td><code>{field(trial, "public_hostname")}</code></td>
                        <td>{dateTime(field(trial, "trial_started_at"))}</td>
                        <td>
                          {dateTime(field(trial, "trial_expires_at"))}
                          {expiredAt && <small>انتهت فعليًا: {dateTime(expiredAt)}</small>}
                        </td>
                        <td>
                          {canRetry ? (
                            <form action={retryCleanupAction}>
                              <input type="hidden" name="tenant_id" value={tenantId} />
                              <button type="submit" className="retry-button">إعادة التنظيف</button>
                            </form>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
