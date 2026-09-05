import { Fragment } from "react";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AdminShell } from "../admin-shell";
import {
  approveTrialConversion,
  createTrial,
  field,
  getNodesData,
  getTrialsData,
  placeTrialProduction,
  requestTrialConversion,
  retryTrialCleanup,
  type JsonRecord,
} from "@/lib/control-plane";

export const dynamic = "force-dynamic";

const SECTORS = [
  ["restaurant", "مطعم"],
  ["cafe", "كافيه"],
  ["retail", "محلات / Retail"],
  ["supermarket", "سوبر ماركت"],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

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

function recordField(record: JsonRecord | null, key: string): JsonRecord | null {
  if (!record) return null;
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
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

async function requestConversionAction(formData: FormData) {
  "use server";

  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  if (!UUID.test(tenantId)) redirect("/trials?error=invalid_trial_id");

  try {
    await requestTrialConversion(tenantId, `admin-conversion:${crypto.randomUUID()}`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "control_plane_unavailable";
    redirect(`/trials?error=${encodeURIComponent(code)}`);
  }

  revalidatePath("/trials");
  revalidatePath("/tenants");
  redirect("/trials?conversion_requested=1");
}

async function approveConversionAction(formData: FormData) {
  "use server";

  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  const conversionId = String(formData.get("conversion_id") ?? "").trim();
  const productionName = String(formData.get("production_name") ?? "").trim();
  const productionSlug = String(formData.get("production_slug") ?? "").trim().toLowerCase();

  if (!UUID.test(tenantId) || !UUID.test(conversionId)) {
    redirect("/trials?error=invalid_conversion_id");
  }
  if (productionSlug && !SAFE_SLUG.test(productionSlug)) {
    redirect("/trials?error=invalid_production_slug");
  }

  try {
    await approveTrialConversion(tenantId, conversionId, productionName, productionSlug);
  } catch (error) {
    const code = error instanceof Error ? error.message : "control_plane_unavailable";
    redirect(`/trials?error=${encodeURIComponent(code)}`);
  }

  revalidatePath("/trials");
  revalidatePath("/tenants");
  revalidatePath("/provisioning");
  redirect("/trials?conversion_approved=1");
}

async function placeProductionAction(formData: FormData) {
  "use server";

  const tenantId = String(formData.get("tenant_id") ?? "").trim();
  const conversionId = String(formData.get("conversion_id") ?? "").trim();
  const nodeId = String(formData.get("node_id") ?? "").trim();

  if (!UUID.test(tenantId) || !UUID.test(conversionId) || !UUID.test(nodeId)) {
    redirect("/trials?error=invalid_production_placement");
  }

  try {
    await placeTrialProduction(tenantId, conversionId, nodeId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "control_plane_unavailable";
    redirect(`/trials?error=${encodeURIComponent(code)}`);
  }

  revalidatePath("/trials");
  revalidatePath("/tenants");
  revalidatePath("/provisioning");
  redirect("/trials?production_placed=1");
}

type TrialsPageProps = {
  searchParams: Promise<{
    created?: string;
    retried?: string;
    conversion_requested?: string;
    conversion_approved?: string;
    production_placed?: string;
    error?: string;
  }>;
};

export default async function TrialsPage({ searchParams }: TrialsPageProps) {
  const [data, nodesData, params] = await Promise.all([getTrialsData(), getNodesData(), searchParams]);
  const counts = {
    total: data.trials.length,
    active: data.trials.filter((trial) => field(trial, "trial_state", "") === "active").length,
    provisioning: data.trials.filter((trial) => field(trial, "trial_state", "") === "provisioning").length,
    failed: data.trials.filter((trial) => field(trial, "trial_state", "") === "failed").length,
  };
  const productionNodes = nodesData.nodes.filter((node) =>
    field(node, "pool", "") === "production"
    && field(node, "lifecycle_state", "") === "active"
    && UUID.test(field(node, "id", "")),
  );

  return (
    <AdminShell active="trials">
      <header className="topbar">
        <div>
          <p className="eyebrow">PHASE 5 / TRIALS</p>
          <h1>التجارب</h1>
          <p className="subtitle">
            إنشاء ومتابعة تجارب Odoo لمدة 3 أيام، ثم تحويلها لمسار Production منفصل وآمن.
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
      {params.conversion_requested === "1" && (
        <div className="notice success">تم تسجيل طلب تحويل التجربة إلى Production جديد.</div>
      )}
      {params.conversion_approved === "1" && (
        <div className="notice success">تمت الموافقة وإنشاء Production target وProvisioning job في حالة آمنة.</div>
      )}
      {params.production_placed === "1" && (
        <div className="notice success">تم وضع Production job على الـNode المختار وبدأ مسار الـProvisioning.</div>
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
              <p className="eyebrow">TRIAL LIFECYCLE + CONVERSION</p>
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
                  <th>Provisioning</th>
                  <th>Node</th>
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
                  <tr><td colSpan={11} className="empty">لا توجد تجارب حتى الآن.</td></tr>
                ) : (
                  data.trials.map((trial) => {
                    const tenantId = field(trial, "id", "");
                    const trialState = field(trial, "trial_state", field(trial, "status"));
                    const provisioningState = field(trial, "status", trialState);
                    const assignedNodeId = field(trial, "assigned_node_id", "");
                    const cleanupState = field(trial, "cleanup_state", "");
                    const cleanupError = field(trial, "cleanup_error_code", "");
                    const canRetry = trialState === "failed" && cleanupState === "failed" && UUID.test(tenantId);
                    const expiredAt = field(trial, "trial_expired_at", "");
                    const conversions = data.conversionsByTrial[tenantId] ?? [];
                    const conversion = conversions[0] ?? null;
                    const conversionId = conversion ? field(conversion, "id", "") : "";
                    const conversionState = conversion ? field(conversion, "state", "") : "";
                    const conversionError = conversion ? field(conversion, "error_code", "") : "";
                    const targetTenant = recordField(conversion, "target_tenant");
                    const provisioningJob = recordField(conversion, "provisioning_job");
                    const targetTenantId = targetTenant ? field(targetTenant, "id", "") : conversion ? field(conversion, "target_tenant_id", "") : "";
                    const jobState = provisioningJob ? field(provisioningJob, "state", "") : "";
                    const jobError = provisioningJob ? field(provisioningJob, "error_code", "") : "";
                    const canRequestConversion = !conversion
                      && new Set(["active", "expired", "cleaned"]).has(trialState)
                      && UUID.test(tenantId);
                    const canApproveConversion = conversionState === "requested"
                      && UUID.test(tenantId)
                      && UUID.test(conversionId);
                    const canPlaceProduction = conversionState === "approved"
                      && UUID.test(tenantId)
                      && UUID.test(conversionId);

                    return (
                      <Fragment key={tenantId}>
                        <tr>
                          <td>
                            <strong>{field(trial, "name")}</strong>
                            <small>{field(trial, "slug")}</small>
                          </td>
                          <td>{field(trial, "sector")}</td>
                          <td><StatusPill value={trialState} /></td>
                          <td><StatusPill value={provisioningState} /></td>
                          <td><code>{assignedNodeId || "—"}</code></td>
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

                        {(conversion || canRequestConversion) && (
                          <tr>
                            <td colSpan={11}>
                              <div className="trial-form-note">
                                {!conversion && canRequestConversion && (
                                  <form action={requestConversionAction}>
                                    <input type="hidden" name="tenant_id" value={tenantId} />
                                    <strong>التحويل إلى Production</strong>
                                    <p>الافتراضي Production جديد ونظيف من الـGolden Template، بدون نقل بيانات الـTrial.</p>
                                    <button type="submit" className="retry-button">طلب التحويل</button>
                                  </form>
                                )}

                                {conversion && (
                                  <div>
                                    <strong>Conversion</strong>{" "}
                                    <StatusPill value={conversionState} />
                                    <p>
                                      Mode: <code>{field(conversion, "mode")}</code>
                                      {targetTenantId && <> · Target: <code>{targetTenantId}</code></>}
                                      {jobState && <> · Job: <StatusPill value={jobState} /></>}
                                    </p>
                                    {(conversionError || jobError) && (
                                      <p>خطأ: <code>{conversionError || jobError}</code></p>
                                    )}

                                    {targetTenant && (
                                      <p>
                                        Production: <strong>{field(targetTenant, "name")}</strong>{" "}
                                        <code>{field(targetTenant, "slug")}</code>{" "}
                                        <StatusPill value={field(targetTenant, "status")} />
                                      </p>
                                    )}

                                    {canApproveConversion && (
                                      <form action={approveConversionAction} className="trial-form">
                                        <input type="hidden" name="tenant_id" value={tenantId} />
                                        <input type="hidden" name="conversion_id" value={conversionId} />
                                        <label>
                                          <span>اسم Production — اختياري</span>
                                          <input name="production_name" type="text" maxLength={120} placeholder={`${field(trial, "name")} Production`} />
                                        </label>
                                        <label>
                                          <span>Production Slug — اختياري</span>
                                          <input name="production_slug" type="text" maxLength={64} dir="ltr" placeholder="يتم توليده تلقائيًا عند تركه فارغًا" />
                                        </label>
                                        <button type="submit" className="primary-button">موافقة وإنشاء Production Target</button>
                                      </form>
                                    )}

                                    {canPlaceProduction && (
                                      <form action={placeProductionAction} className="trial-form">
                                        <input type="hidden" name="tenant_id" value={tenantId} />
                                        <input type="hidden" name="conversion_id" value={conversionId} />
                                        <label>
                                          <span>Production Node</span>
                                          <select name="node_id" required defaultValue="">
                                            <option value="" disabled>اختر Production Node</option>
                                            {productionNodes.map((node) => (
                                              <option value={field(node, "id", "")} key={field(node, "id", "")}>
                                                {field(node, "name", field(node, "id"))} · {field(node, "role")} · {field(node, "pool")}
                                              </option>
                                            ))}
                                          </select>
                                        </label>
                                        <div className="trial-form-note">
                                          التنفيذ Fail-closed؛ حتى بعد الاختيار لن يبدأ Production إلا إذا كان الـControl Plane مفعّل له صراحةً.
                                        </div>
                                        <button type="submit" className="primary-button" disabled={productionNodes.length === 0}>
                                          تأكيد Placement على Production
                                        </button>
                                        {productionNodes.length === 0 && (
                                          <small className="muted">لا يوجد Production Node مؤهل ظاهر حاليًا.</small>
                                        )}
                                      </form>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
