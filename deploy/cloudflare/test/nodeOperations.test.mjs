import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProvisionOperationPayload,
  expectedDatabaseName,
  parseOperationResult,
} from "../src/nodeOperations.ts";

test("builds deterministic bounded provisioning payload without command fields", () => {
  const payload = buildProvisionOperationPayload({
    job_id: "job-1",
    state: "placed",
    tenant_id: "12345678-abcd-4abc-8abc-1234567890ab",
    tenant_slug: "demo-restaurant",
    sector: "restaurant",
    environment_kind: "test",
    template_id: "template-restaurant-v1",
    template_version: 1,
    odoo_major: 18,
    database_prefix: "dsx_restaurant",
    module_manifest: JSON.stringify(["point_of_sale", "ds_pos_delivery", "bad module", "/bin/sh"]),
  });

  assert.equal(payload.database_name, "dsx_restaurant_demo_restaurant_12345678");
  assert.deepEqual(payload.modules, ["point_of_sale", "ds_pos_delivery"]);
  assert.equal("command" in payload, false);
  assert.equal("shell" in payload, false);
  assert.equal("sql" in payload, false);
  assert.equal("password" in payload, false);
  assert.equal("path" in payload, false);
});

test("database name is deterministic and PostgreSQL-safe", () => {
  assert.equal(
    expectedDatabaseName("dsx_cafe", "my-cafe", "abcdef12-3456-7890-abcd-ef1234567890"),
    "dsx_cafe_my_cafe_abcdef12",
  );
});

test("operation result only accepts bounded states and safe fields", () => {
  assert.deepEqual(
    parseOperationResult({ lease_token: "dsx_lease_1234567890123456", state: "running" }),
    {
      lease_token: "dsx_lease_1234567890123456",
      state: "running",
      error_code: null,
      database_name: null,
    },
  );

  assert.deepEqual(
    parseOperationResult({
      lease_token: "dsx_lease_1234567890123456",
      state: "failed",
      error_code: "postgres_create_failed",
    }),
    {
      lease_token: "dsx_lease_1234567890123456",
      state: "failed",
      error_code: "postgres_create_failed",
      database_name: null,
    },
  );

  assert.throws(
    () => parseOperationResult({ lease_token: "dsx_lease_1234567890123456", state: "shell" }),
    /invalid_operation_state/,
  );
  assert.throws(
    () => parseOperationResult({
      lease_token: "dsx_lease_1234567890123456",
      state: "failed",
      error_code: "rm -rf /",
    }),
    /invalid_error_code/,
  );
  assert.throws(
    () => parseOperationResult({
      lease_token: "dsx_lease_1234567890123456",
      state: "ready",
      database_name: "bad-db-name",
    }),
    /invalid_database_name/,
  );
});
