import test from "node:test";
import assert from "node:assert/strict";
import { cleanupEligibility, cleanupRetryEligibility } from "../src/cleanup.ts";

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

test("cleanup retry requires failed test tenant with exact retained identity", () => {
  const job = {
    state: "failed",
    node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
  };
  const tenant = {
    id: "tenant-1",
    environment_kind: "test",
    status: "failed",
    assigned_node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
  };

  assert.equal(cleanupRetryEligibility(job, tenant), null);
  assert.equal(
    cleanupRetryEligibility({ ...job, state: "running" }, tenant),
    "cleanup_retry_requires_failed_job",
  );
  assert.equal(
    cleanupRetryEligibility(job, { ...tenant, environment_kind: "production" }),
    "cleanup_retry_non_test_environment_blocked",
  );
  assert.equal(
    cleanupRetryEligibility(job, { ...tenant, assigned_node_id: "node-2" }),
    "cleanup_retry_node_mismatch",
  );
  assert.equal(
    cleanupRetryEligibility(job, { ...tenant, database_name: "other_database" }),
    "cleanup_retry_database_mismatch",
  );
});
