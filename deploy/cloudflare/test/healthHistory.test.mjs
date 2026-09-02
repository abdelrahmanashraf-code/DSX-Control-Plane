import test from "node:test";
import assert from "node:assert/strict";
import { listNodeHealthHistory, parseHealthHistoryLimit } from "../src/healthHistory.ts";

test("health history limit is bounded", () => {
  assert.equal(parseHealthHistoryLimit(null), 72);
  assert.equal(parseHealthHistoryLimit("12"), 12);
  assert.equal(parseHealthHistoryLimit("0"), 1);
  assert.equal(parseHealthHistoryLimit("9999"), 288);
  assert.equal(parseHealthHistoryLimit("bad"), 72);
});

test("health history requires admin authentication before database access", async () => {
  const env = {
    ADMIN_API_TOKEN: "admin-secret",
    DB: {
      prepare() {
        throw new Error("database must not be touched for unauthorized requests");
      },
    },
  };

  const request = new Request(
    "https://control.example/v1/admin/nodes/11111111-1111-1111-1111-111111111111/health-history",
  );
  const response = await listNodeHealthHistory(
    request,
    env,
    "11111111-1111-1111-1111-111111111111",
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});
