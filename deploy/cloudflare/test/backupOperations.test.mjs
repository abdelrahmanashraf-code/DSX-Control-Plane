import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBackupOperationPayload,
  parseBackupOperationResult,
} from "../src/backupOperations.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

test("backup operation payload contains identity only and no paths or credentials", () => {
  const payload = buildBackupOperationPayload({
    backup_job_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tenant_id: "12345678-abcd-4abc-8abc-1234567890ab",
    provisioning_job_id: "94510378-b752-4dab-a4c7-625af6a9b252",
    template_id: "template-restaurant-v1",
    node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    database_name: "dsx_restaurant_phase4_12345678",
    environment_kind: "test",
    backup_type: "full",
    state: "queued",
  });

  assert.deepEqual(payload, {
    tenant_id: "12345678-abcd-4abc-8abc-1234567890ab",
    environment_kind: "test",
    template_id: "template-restaurant-v1",
    provisioning_operation_id: "94510378-b752-4dab-a4c7-625af6a9b252",
    database_name: "dsx_restaurant_phase4_12345678",
    backup_type: "full",
  });
  assert.equal("path" in payload, false);
  assert.equal("command" in payload, false);
  assert.equal("dsn" in payload, false);
  assert.equal("password" in payload, false);
});

test("prepared backup result requires complete checksummed artifact set", () => {
  const parsed = parseBackupOperationResult({
    lease_token: "dsx_backup_lease_12345678901234567890",
    state: "prepared",
    manifest_sha256: SHA_C,
    total_size_bytes: 60,
    artifacts: [
      { artifact_kind: "database_dump", size_bytes: 10, sha256: SHA_A },
      { artifact_kind: "filestore_archive", size_bytes: 20, sha256: SHA_B },
      { artifact_kind: "manifest", size_bytes: 30, sha256: SHA_C },
    ],
  });

  assert.equal(parsed.state, "prepared");
  assert.equal(parsed.total_size_bytes, 60);
  assert.equal(parsed.artifacts.length, 3);

  assert.throws(
    () => parseBackupOperationResult({
      lease_token: "dsx_backup_lease_12345678901234567890",
      state: "prepared",
      manifest_sha256: SHA_A,
      total_size_bytes: 60,
      artifacts: [
        { artifact_kind: "database_dump", size_bytes: 10, sha256: SHA_A },
        { artifact_kind: "filestore_archive", size_bytes: 20, sha256: SHA_B },
        { artifact_kind: "manifest", size_bytes: 30, sha256: SHA_C },
      ],
    }),
    /backup_manifest_checksum_mismatch/,
  );
});

test("backup operation result rejects arbitrary metadata fields", () => {
  assert.throws(
    () => parseBackupOperationResult({
      lease_token: "dsx_backup_lease_12345678901234567890",
      state: "prepared",
      manifest_sha256: SHA_C,
      total_size_bytes: 60,
      path: "/var/lib/dsx-provisioner/backups",
      artifacts: [
        { artifact_kind: "database_dump", size_bytes: 10, sha256: SHA_A },
        { artifact_kind: "filestore_archive", size_bytes: 20, sha256: SHA_B },
        { artifact_kind: "manifest", size_bytes: 30, sha256: SHA_C },
      ],
    }),
    /invalid_backup_prepared_fields/,
  );
});
