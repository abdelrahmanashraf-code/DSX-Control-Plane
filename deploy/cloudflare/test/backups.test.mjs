import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backupEligibility, parseBackupJobInput } from "../src/backups.ts";

test("backup input is bounded and full-backup only", () => {
  assert.deepEqual(
    parseBackupJobInput({
      tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-backup-gate-v1",
    }),
    {
      tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-backup-gate-v1",
      backup_type: "full",
    },
  );

  assert.throws(
    () => parseBackupJobInput({
      tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-backup-gate-v1",
      backup_type: "database-only",
    }),
    /unsupported_backup_type/,
  );

  assert.throws(
    () => parseBackupJobInput({
      tenant_id: "not-a-valid-tenant-id",
      idempotency_key: "phase4-backup-gate-v1",
    }),
    /invalid_tenant_id/,
  );
});

test("Phase 4 backup gate is test-only and requires ready tenant identity", () => {
  const valid = {
    id: "60ce37cb-2225-455c-9967-db4a249f0f72",
    environment_kind: "test",
    status: "ready",
    assigned_node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    database_name: "dsx_restaurant_phase4_gate_60ce37cb",
  };

  assert.equal(backupEligibility(valid), null);
  assert.equal(
    backupEligibility({ ...valid, environment_kind: "production" }),
    "backup_non_test_environment_blocked",
  );
  assert.equal(
    backupEligibility({ ...valid, status: "decommissioned" }),
    "tenant_not_backup_ready",
  );
  assert.equal(
    backupEligibility({ ...valid, assigned_node_id: null }),
    "backup_node_missing",
  );
  assert.equal(
    backupEligibility({ ...valid, database_name: null }),
    "backup_database_missing",
  );
});

test("backup migration models complete backup sets and bounded lifecycle", () => {
  const migration = readFileSync(
    new URL("../migrations/0008_phase4_backup_jobs.sql", import.meta.url),
    "utf8",
  );

  for (const state of ["queued", "dispatched", "running", "uploaded", "verified", "failed"]) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  for (const kind of ["database_dump", "filestore_archive", "manifest"]) {
    assert.match(migration, new RegExp(`'${kind}'`));
  }
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(migration, /manifest_sha256/);
});
