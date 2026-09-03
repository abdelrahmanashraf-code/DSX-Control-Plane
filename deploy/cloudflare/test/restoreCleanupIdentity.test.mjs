import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("validated restores materialize a cleanup-compatible typed identity", () => {
  const migration = readFileSync(
    new URL("../migrations/0013_phase4_restore_cleanup_identity.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /origin_kind TEXT NOT NULL DEFAULT 'provisioning'/);
  assert.match(migration, /origin_kind IN \('provisioning', 'restore'\)/);
  assert.match(migration, /AFTER UPDATE OF state ON restore_jobs/);
  assert.match(migration, /NEW\.state = 'validated'/);
  assert.match(migration, /NEW\.id, NEW\.target_tenant_id, NEW\.template_id, NEW\.node_id/);
  assert.match(migration, /'restore:' \|\| NEW\.id/);
  assert.match(migration, /'restore'/);
  assert.match(migration, /'restore\.materialized'/);
});
