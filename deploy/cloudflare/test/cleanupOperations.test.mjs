import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCleanupOperationPayload,
  parseCleanupOperationResult,
} from "../src/cleanupOperations.ts";

test("cleanup payload carries identity only and no command/path/sql fields", () => {
  const payload = buildCleanupOperationPayload({
    cleanup_job_id: "cleanup-1",
    tenant_id: "tenant-1",
    provisioning_job_id: "provision-1",
    template_id: "template-restaurant-v1",
    node_id: "node-1",
    database_name: "dsx_restaurant_demo_12345678",
    environment_kind: "test",
    state: "queued",
  });

  assert.deepEqual(payload, {
    tenant_id: "tenant-1",
    environment_kind: "test",
    template_id: "template-restaurant-v1",
    provisioning_operation_id: "provision-1",
    database_name: "dsx_restaurant_demo_12345678",
  });
  for (const forbidden of ["command", "shell", "sql", "password", "path"]) {
    assert.equal(forbidden in payload, false);
  }
});

test("cleanup result accepts only running, cleaned or bounded failed", () => {
  assert.deepEqual(
    parseCleanupOperationResult({ lease_token: "dsx_cleanup_lease_1234567890123456", state: "cleaned" }),
    {
      lease_token: "dsx_cleanup_lease_1234567890123456",
      state: "cleaned",
      error_code: null,
    },
  );
  assert.throws(
    () => parseCleanupOperationResult({
      lease_token: "dsx_cleanup_lease_1234567890123456",
      state: "shell",
    }),
    /invalid_cleanup_operation_state/,
  );
  assert.throws(
    () => parseCleanupOperationResult({
      lease_token: "dsx_cleanup_lease_1234567890123456",
      state: "failed",
      error_code: "rm -rf /",
    }),
    /invalid_error_code/,
  );
});
