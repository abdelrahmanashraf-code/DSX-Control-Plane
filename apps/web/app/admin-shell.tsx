import Link from "next/link";
import type { ReactNode } from "react";

const NAV_ITEMS = [
  { arabic: "الرئيسية", english: "Dashboard", href: "/", key: "dashboard", enabled: true },
  { arabic: "التجارب", english: "Trials", href: "/trials", key: "trials", enabled: true },
  { arabic: "العملاء", english: "Tenants", href: "/tenants", key: "tenants", enabled: true },
  { arabic: "السيرفرات", english: "Nodes", href: "/nodes", key: "nodes", enabled: true },
  { arabic: "العمليات", english: "Provisioning", href: "/provisioning", key: "provisioning", enabled: false },
  { arabic: "النسخ", english: "Backups & Restore", href: "/backups", key: "backups", enabled: false },
  { arabic: "التنبيهات", english: "Alerts", href: "/alerts", key: "alerts", enabled: false },
  { arabic: "السجل", english: "Audit Log", href: "/audit", key: "audit", enabled: false },
] as const;

type AdminShellProps = {
  active: (typeof NAV_ITEMS)[number]["key"];
  children: ReactNode;
};

export function AdminShell({ active, children }: AdminShellProps) {
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand brand-link" aria-label="DSX Control Panel">
          <div className="brand-mark">DSX</div>
          <div>
            <strong>Control Panel</strong>
            <small>SaaS Operations</small>
          </div>
        </Link>

        <nav className="nav-list" aria-label="التنقل الرئيسي">
          {NAV_ITEMS.map((item) => {
            const className = `nav-item${item.key === active ? " active" : ""}${item.enabled ? "" : " disabled"}`;
            if (!item.enabled) {
              return (
                <div className={className} key={item.key} aria-disabled="true">
                  <span>{item.arabic}</span>
                  <small>{item.english}</small>
                </div>
              );
            }
            return (
              <Link className={className} href={item.href} key={item.key}>
                <span>{item.arabic}</span>
                <small>{item.english}</small>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <span className="dot" />
          Phase 5 — Trial Automation
        </div>
      </aside>

      <section className="content">{children}</section>
    </main>
  );
}
