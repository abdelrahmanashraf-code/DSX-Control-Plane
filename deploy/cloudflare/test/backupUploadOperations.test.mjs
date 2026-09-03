import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBackupUploadOperationPayload,
  expectedBackupObjectKey,
  parseBackupUploadResult,
} from "../src/backupUploadOperations.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function source() {
  return {
    backup_job_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tenant_id: "12345678-abcd-4abc-8abc-1234567890ab",
    provisioning_job_id: "94510378-b752-4dab-a4c7-625af6a9b252",
    template_id: "template-restaurant-v1",
    node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    database_name: "dsx_restaurant_phase4_12345678",
    environment_kind: "test",
    backup_type: "full",
    state: "prepared",
    manifest_sha256: SHA_C,
    total_size_bytes: 60,
  };
}

const artifacts = [
  { artifact_kind: "database_dump", size_bytes: 10, sha256: SHA_A },
  { artifact_kind: "filestore_archive", size_bytes: 20, sha256: SHA_B },
  { artifact_kind: "manifest", size_bytes: 30, sha256: SHA_C },
];

test("backup upload payload contains identity and checksums only", () => {
  const payload = buildBackupUploadOperationPayload(source(), artifacts);
  assert.deepEqual(payload, {
    tenant_id: source().tenant_id,
    environment_kind: "test",
    template_id: "template-restaurant-v1",
    provisioning_operation_id: source().provisioning_job_id,
    database_name: "dsx_restaurant_phase4_12345678",
    backup_type: "full",
    manifest_sha256: SHA_C,
    total_size_bytes: 60,
    artifacts,
  });
  for (const forbidden of ["path", "bucket", "endpoint", "access_key", "secret_key", "password", "dsn"]) {
    assert.equal(forbidden in payload, false);
  }
});

test("backup object keys are deterministic and not supplied by control-plane claims", () => {
  assert.equal(
    expectedBackupObjectKey(source().tenant_id, source().backup_job_id, "database_dump"),
    `test/${source().tenant_id}/${source().backup_job_id}/database.dump`,
  );
  assert.equal(
    expectedBackupObjectKey(source().tenant_id, source().backup_job_id, "filestore_archive"),
    `test/${source().tenant_id}/${source().backup_job_id}/filestore.tar.gz`,
  );
});

test("verified result requires exact storage metadata and rejects arbitrary fields", () => {
  const parsed = parseBackupUploadResult({
    lease_token: "dsx_backup_upload_lease_12345678901234567890",
    state: "verified",
    artifacts: artifacts.map((item) => ({
      ...item,
      object_key: expectedBackupObjectKey(source().tenant_id, source().backup_job_id, item.artifact_kind),
      object_version: "etag:abc123",
    })),
  });
  assert.equal(parsed.state, "verified");
  assert.equal(parsed.artifacts.length, 3);

  assert.throws(
    () => parseBackupUploadResult({
      lease_token: "dsx_backup_upload_lease_12345678901234567890",
      state: "verified",
      bucket: "should-not-be-accepted",
      artifacts: artifacts.map((item) => ({
        ...item,
        object_key: "test/x/y/z",
        object_version: "etag:abc123",
      })),
    }),
    /invalid_backup_upload_verified_fields/,
  );
});

test("failed upload result is retryable-shaped and contains no storage secret", () => {
  const parsed = parseBackupUploadResult({
    lease_token: "dsx_backup_upload_lease_12345678901234567890",
    state: "failed",
    error_code: "backup_storage_unavailable",
  });
  assert.equal(parsed.state, "failed");
  assert.equal(parsed.error_code, "backup_storage_unavailable");
});
