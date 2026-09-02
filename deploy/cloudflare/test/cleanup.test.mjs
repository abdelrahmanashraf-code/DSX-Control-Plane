import test from "node:test";
import assert from "node:assert/strict";
import { cleanupEligibility } from "../src/cleanup.ts";

test("cleanup only accepts ready test tenants with node and database identity", () => {
  assert.equal(cleanupEligibility({
    id: "tenant-1",
    environment_kind: "test",
    status: "ready",
    assigned_node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
  }), null);

  assert.equal(cleanupEligibility({
    id: "tenant-1",
    environment_kind: "production",
    status: "ready",
    assigned_node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
  }), "cleanup_non_test_environment_blocked");

  assert.equal(cleanupEligibility({
    id: "tenant-1",
    environment_kind: "test",
    status: "failed",
    assigned_node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
  }), "tenant_not_cleanup_ready");
});
