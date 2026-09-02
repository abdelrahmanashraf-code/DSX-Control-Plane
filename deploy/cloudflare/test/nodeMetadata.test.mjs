import test from "node:test";
import assert from "node:assert/strict";
import { parseNodeMetadata } from "../src/nodeMetadata.ts";

test("accepts safe node metadata", () => {
  assert.deepEqual(
    parseNodeMetadata({
      role: "odoo-postgres",
      pool: "trial-egypt",
      labels: { region: "fsn1", "workload/sector": "restaurant" },
      max_tenants: 80,
      reserved_memory_mb: 2048,
      reserved_disk_gb: 20,
    }),
    {
      role: "odoo-postgres",
      pool: "trial-egypt",
      labels: { region: "fsn1", "workload/sector": "restaurant" },
      max_tenants: 80,
      reserved_memory_mb: 2048,
      reserved_disk_gb: 20,
    },
  );
});

test("uses safe defaults", () => {
  assert.deepEqual(parseNodeMetadata({}), {
    role: "odoo-postgres",
    pool: "default",
    labels: {},
    max_tenants: null,
    reserved_memory_mb: 0,
    reserved_disk_gb: 0,
  });
});

test("rejects unknown roles and unsafe pools", () => {
  assert.throws(() => parseNodeMetadata({ role: "shell" }), /invalid_role/);
  assert.throws(() => parseNodeMetadata({ pool: "Production Pool" }), /invalid_pool/);
});

test("rejects invalid capacity and labels", () => {
  assert.throws(() => parseNodeMetadata({ max_tenants: 0 }), /invalid_capacity_value/);
  assert.throws(() => parseNodeMetadata({ labels: { Region: "" } }), /invalid_label/);
});
