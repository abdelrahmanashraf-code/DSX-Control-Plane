import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeAlerts, listOperationalAlerts } from "../src/alerts.ts";

test("builds availability and service alerts from bounded metrics", () => {
  const now = Date.parse("2026-09-02T08:00:00Z");
  const row = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "DSX-TEST-01",
    last_seen_at: "2026-09-02T07:53:00Z",
    metrics: JSON.stringify({
      cpu_percent: 50,
      memory_percent: 91,
      disk_percent: 92,
      services: {
        odoo: { running: false },
        postgresql: { running: true },
      },
    }),
  };

  const alerts = buildNodeAlerts(row, now, 90, 300);
  const codes = new Set(alerts.map((alert) => alert.code));

  assert.ok(codes.has("node_offline"));
  assert.ok(codes.has("disk_usage_critical"));
  assert.ok(codes.has("memory_usage_high"));
  assert.ok(codes.has("odoo_not_running"));
  assert.ok(!codes.has("postgresql_not_running"));
});

test("healthy recent node produces no alerts", () => {
  const now = Date.parse("2026-09-02T08:00:00Z");
  const row = {
    id: "22222222-2222-2222-2222-222222222222",
    name: "DSX-TEST-02",
    last_seen_at: "2026-09-02T07:59:30Z",
    metrics: JSON.stringify({
      cpu_percent: 20,
      memory_percent: 40,
      disk_percent: 45,
      services: {
        odoo: { running: true },
        postgresql: { running: true },
      },
    }),
  };

  assert.deepEqual(buildNodeAlerts(row, now, 90, 300), []);
});

test("alerts endpoint requires admin auth before database access", async () => {
  const env = {
    ADMIN_API_TOKEN: "admin-secret",
    DB: {
      prepare() {
        throw new Error("database must not be touched for unauthorized requests");
      },
    },
  };
  const request = new Request("https://control.example/v1/admin/alerts");

  const response = await listOperationalAlerts(request, env);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});
