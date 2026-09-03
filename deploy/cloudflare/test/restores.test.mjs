import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  backupArtifactsComplete,
  deterministicRestoreDatabaseName,
  parseRestoreJobInput,
  restoreEligibility,
} from "../src/restores.ts";

test("restore input is strict and idempotent-key bounded", () => {
  assert.deepEqual(
    parseRestoreJobInput({
      backup_job_id: "c57703c6-48a1-4f5f-85f0-f98328cb7688",
      target_tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-restore-gate-v1",
    }),
    {
      backup_job_id: "c57703c6-48a1-4f5f-85f0-f98328cb7688",
      target_tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-restore-gate-v1",
    },
  );

  assert.throws(
    () => parseRestoreJobInput({
      backup_job_id: "bad",
      target_tenant_id: "60ce37cb-2225-455c-9967-db4a249f0f72",
      idempotency_key: "phase4-restore-gate-v1",
    }),
    /invalid_backup_job_id/,
  );
});

test("restore gate is verified-full-test-only and requires fresh disposable target", () => {
  const backup = {
    state: "verified",
    environment_kind: "test",
    backup_type: "full",
    source_tenant_id: "5b6099ab-282e-4c7b-a5eb-9b607e2e2362",
    sector: "restaurant",
  };
  const target = {
    id: "60ce37cb-2225-455c-9967-db4a249f0f72",
    slug: "phase4-restore-gate",
    sector: "restaurant",
    environment_kind: "test",
    status: "pending",
    assigned_node_id: null,
    database_name: null,
  };

  assert.equal(restoreEligibility(backup, target), null);
  assert.equal(restoreEligibility({ ...backup, state: "prepared" }, target), "restore_backup_not_verified");
  assert.equal(
    restoreEligibility({ ...backup, environment_kind: "production" }, target),
    "restore_non_test_environment_blocked",
  );
  assert.equal(
    restoreEligibility(backup, { ...target, id: backup.source_tenant_id }),
    "restore_target_must_be_disposable",
  );
  assert.equal(
    restoreEligibility(backup, { ...target, status: "ready" }),
    "restore_target_not_pending",
  );
  assert.equal(
    restoreEligibility(backup, { ...target, database_name: "already_used" }),
    "restore_target_identity_not_empty",
  );
  assert.equal(
    restoreEligibility(backup, { ...target, sector: "retail" }),
    "restore_sector_mismatch",
  );
});

test("restore database name is deterministic, safe, distinct and bounded", () => {
  const value = deterministicRestoreDatabaseName(
    "dsx_restaurant",
    "phase4-restore-gate-20260903",
    "60ce37cb-2225-455c-9967-db4a249f0f72",
  );
  assert.equal(value, deterministicRestoreDatabaseName(
    "dsx_restaurant",
    "phase4-restore-gate-20260903",
    "60ce37cb-2225-455c-9967-db4a249f0f72",
  ));
  assert.match(value, /^[a-z][a-z0-9_]{2,62}$/);
  assert.ok(value.length <= 63);
  assert.ok(value.startsWith("dsx_restaurant_restore_"));
  assert.match(value, /60ce37cb$/);
});

test("long restore slug truncates slug only and preserves local database prefix", () => {
  const value = deterministicRestoreDatabaseName(
    "dsx_restaurant",
    "phase4-restore-ownership-gate-20260903",
    "2a2645e9-9ad5-4a62-a565-9ad048bed4a7",
  );

  assert.ok(value.startsWith("dsx_restaurant_restore_"));
  assert.ok(value.endsWith("_2a2645e9"));
  assert.ok(value.length <= 63);
  assert.equal(value, "dsx_restaurant_restore_phase4_restore_ownership_gate_2_2a2645e9");
});

test("restore requires exact verified remote artifact set", () => {
  const artifacts = [
    {
      artifact_kind: "database_dump",
      object_key: "test/t/b/database.dump",
      object_version: "etag:db",
      size_bytes: 12,
      sha256: "a".repeat(64),
    },
    {
      artifact_kind: "filestore_archive",
      object_key: "test/t/b/filestore.tar.gz",
      object_version: "etag:fs",
      size_bytes: 9,
      sha256: "b".repeat(64),
    },
    {
      artifact_kind: "manifest",
      object_key: "test/t/b/manifest.json",
      object_version: "etag:manifest",
      size_bytes: 7,
      sha256: "c".repeat(64),
    },
  ];
  assert.equal(backupArtifactsComplete(artifacts), true);
  assert.equal(backupArtifactsComplete(artifacts.slice(0, 2)), false);
  assert.equal(backupArtifactsComplete([{ ...artifacts[0], object_key: null }, ...artifacts.slice(1)]), false);
  assert.equal(backupArtifactsComplete([{ ...artifacts[0], sha256: "bad" }, ...artifacts.slice(1)]), false);
});

test("restore migration models bounded lifecycle and target reservation", () => {
  const migration = readFileSync(
    new URL("../migrations/0011_phase4_restore_jobs.sql", import.meta.url),
    "utf8",
  );

  for (const state of ["queued", "dispatched", "running", "restored", "validated", "failed"]) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.match(migration, /backup_job_id/);
  assert.match(migration, /source_tenant_id/);
  assert.match(migration, /target_tenant_id/);
  assert.match(migration, /target_database_name TEXT NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(target_tenant_id, idempotency_key\)/);
});
