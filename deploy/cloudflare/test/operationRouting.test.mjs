import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("restore result routing is guarded by restore job ownership", () => {
  const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

  assert.match(
    app,
    /SELECT id FROM restore_jobs WHERE id = \?/,
  );
  assert.match(
    app,
    /restoreOwnsResult = Boolean\(restoreJob\)/,
  );
  assert.match(
    app,
    /if \(!operationResultMatch \|\| restoreOwnsResult\)/,
  );

  const restoreIndex = app.indexOf("handleRestoreOperationRoute(request, env)");
  const cleanupIndex = app.indexOf("handleCleanupOperationRoute(request, env)");
  assert.ok(restoreIndex >= 0);
  assert.ok(cleanupIndex > restoreIndex);
});
