import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildRestoreOperationPayload,
  expectedRestoreObjectKey,
  parseRestoreResult,
} from "../src/restoreOperations.ts";

const source = {
  restore_job_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  backup_job_id: "c57703c6-48a1-4f5f-85f0-f98328cb7688",
  source_tenant_id: "5b6099ab-282e-4c7b-a5eb-9b607e2e2362",
  target_tenant_id: "11111111-2222-4333-8444-555555555555",
  template_id: "template-restaurant-v1",
  node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
  source_provisioning_operation_id: "d93f3452-a58d-463b-9295-5852c973dcc9",
  source_database_name: "dsx_restaurant_phase4_backup_gate_20260903_5b6099ab",
  target_database_name: "dsx_restaurant_restore_phase4_restore_gate_11111111",
  environment_kind: "test",
  state: "queued",
  manifest_sha256: "6c2c61eb303e55ac70e01f459411d6961edc0fca21cd39e38a13aa68c709157d",
  total_size_bytes: 21,
};

const artifacts = [
  {
    artifact_kind: "database_dump",
    object_key: expectedRestoreObjectKey(source.source_tenant_id, source.backup_job_id, "database_dump"),
    object_version: "etag:db",
    size_bytes: 10,
    sha256: "a".repeat(64),
  },
  {
    artifact_kind: "filestore_archive",
    object_key: expectedRestoreObjectKey(source.source_tenant_id, source.backup_job_id, "filestore_archive"),
    object_version: "etag:fs",
    size_bytes: 10,
    sha256: "b".repeat(64),
  },
  {
    artifact_kind: "manifest",
    object_key: expectedRestoreObjectKey(source.source_tenant_id, source.backup_job_id, "manifest"),
    object_version: "etag:manifest",
    size_bytes: 1,
    sha256: source.manifest_sha256,
  },
];

test("restore payload contains identity and verified object metadata only", () => {
  const payload = buildRestoreOperationPayload(source, artifacts);
  assert.equal(payload.backup_job_id, source.backup_job_id);
  assert.equal(payload.target_database_name, source.target_database_name);
  assert.deepEqual(payload.artifacts, artifacts);
  assert.equal("bucket" in payload, false);
  assert.equal("endpoint" in payload, false);
  assert.equal("access_key" in payload, false);
  assert.equal("secret" in payload, false);
  assert.equal("local_path" in payload, false);
});

test("restore result parser accepts only bounded states", () => {
  assert.deepEqual(
    parseRestoreResult({ lease_token: "restore_lease_1234567890", state: "running" }),
    {
      lease_token: "restore_lease_1234567890",
      state: "running",
      error_code: null,
      database_name: null,
    },
  );
  assert.deepEqual(
    parseRestoreResult({
      lease_token: "restore_lease_1234567890",
      state: "validated",
      database_name: source.target_database_name,
    }),
    {
      lease_token: "restore_lease_1234567890",
      state: "validated",
      error_code: null,
      database_name: source.target_database_name,
    },
  );
  assert.throws(
    () => parseRestoreResult({ lease_token: "restore_lease_1234567890", state: "shell" }),
    /invalid_restore_state/,
  );
});

test("restore lease migration is bounded to restore jobs", () => {
  const migration = readFileSync(
    new URL("../migrations/0012_phase4_restore_operation_leases.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /restore_operation_leases/);
  assert.match(migration, /REFERENCES restore_jobs\(id\) ON DELETE CASCADE/);
  assert.match(migration, /lease_token_hash/);
  assert.match(migration, /lease_expires_at/);
});
