import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionProvisioningState,
  parseProvisioningJobInput,
  parseTenantInput,
  selectPlacementNode,
} from "../src/provisioning.ts";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function candidate(overrides = {}) {
  return {
    id: "node-a",
    lifecycle_state: "active",
    role: "odoo-postgres",
    pool: "non-production",
    last_seen_at: "2026-09-02T15:00:00.000Z",
    max_tenants: 10,
    reserved_memory_mb: 1024,
    reserved_disk_gb: 10,
    tenant_count: 0,
    metrics: {
      memory: { available_bytes: 6 * 1024 * MIB },
      disk: { free_bytes: 50 * GIB },
    },
    ...overrides,
  };
}

test("provisioning state machine only allows bounded transitions", () => {
  assert.equal(canTransitionProvisioningState("queued", "placed"), true);
  assert.equal(canTransitionProvisioningState("placed", "dispatched"), true);
  assert.equal(canTransitionProvisioningState("running", "ready"), true);
  assert.equal(canTransitionProvisioningState("running", "failed"), true);
  assert.equal(canTransitionProvisioningState("failed", "retrying"), true);
  assert.equal(canTransitionProvisioningState("retrying", "dispatched"), true);

  assert.equal(canTransitionProvisioningState("queued", "ready"), false);
  assert.equal(canTransitionProvisioningState("ready", "running"), false);
  assert.equal(canTransitionProvisioningState("failed", "ready"), false);
});

test("tenant input is bounded to known sectors and environment kinds", () => {
  assert.deepEqual(
    parseTenantInput({
      name: "Test Restaurant",
      slug: "test-restaurant",
      sector: "restaurant",
      environment_kind: "test",
    }),
    {
      name: "Test Restaurant",
      slug: "test-restaurant",
      sector: "restaurant",
      environment_kind: "test",
    },
  );

  assert.throws(() => parseTenantInput({ name: "X", slug: "bad slug", sector: "restaurant" }), /invalid_tenant_slug/);
  assert.throws(() => parseTenantInput({ name: "X", slug: "safe-slug", sector: "shell" }), /invalid_sector/);
  assert.throws(
    () => parseTenantInput({ name: "X", slug: "safe-slug", sector: "cafe", environment_kind: "root" }),
    /invalid_environment_kind/,
  );
});

test("provisioning job input requires safe idempotency and placement pool", () => {
  assert.deepEqual(
    parseProvisioningJobInput({
      tenant_id: "tenant-1",
      template_id: "template-restaurant-v1",
      idempotency_key: "request:restaurant:0001",
      pool: "non-production",
    }),
    {
      tenant_id: "tenant-1",
      template_id: "template-restaurant-v1",
      idempotency_key: "request:restaurant:0001",
      pool: "non-production",
    },
  );

  assert.throws(
    () => parseProvisioningJobInput({ tenant_id: "tenant-1", template_id: "template-restaurant-v1", idempotency_key: "short" }),
    /invalid_idempotency_key/,
  );
  assert.throws(
    () => parseProvisioningJobInput({
      tenant_id: "tenant-1",
      template_id: "template-restaurant-v1",
      idempotency_key: "request:restaurant:0001",
      pool: "Production Pool",
    }),
    /invalid_pool/,
  );
});

test("placement prefers healthy node with lower tenant pressure", () => {
  const now = Date.parse("2026-09-02T15:01:00.000Z");
  const selected = selectPlacementNode(
    [
      candidate({ id: "node-loaded", tenant_count: 7 }),
      candidate({ id: "node-light", tenant_count: 1, metrics: {
        memory: { available_bytes: 5 * 1024 * MIB },
        disk: { free_bytes: 40 * GIB },
      } }),
    ],
    {
      required_role: "odoo-postgres",
      pool: "non-production",
      min_memory_mb: 1024,
      min_disk_gb: 10,
    },
    now,
    300,
  );

  assert.equal(selected?.id, "node-light");
});

test("placement rejects offline, full, or under-capacity nodes", () => {
  const now = Date.parse("2026-09-02T15:10:00.000Z");
  const selected = selectPlacementNode(
    [
      candidate({ id: "offline", last_seen_at: "2026-09-02T15:00:00.000Z" }),
      candidate({ id: "full", last_seen_at: "2026-09-02T15:09:30.000Z", tenant_count: 10 }),
      candidate({
        id: "small",
        last_seen_at: "2026-09-02T15:09:30.000Z",
        metrics: { memory: { available_bytes: 1200 * MIB }, disk: { free_bytes: 15 * GIB } },
      }),
    ],
    {
      required_role: "odoo-postgres",
      pool: "non-production",
      min_memory_mb: 1024,
      min_disk_gb: 10,
    },
    now,
    300,
  );

  assert.equal(selected, null);
});
