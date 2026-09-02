import test from "node:test";
import assert from "node:assert/strict";
import { retryMode } from "../src/provisioningRetry.ts";

test("only failed jobs may enter administrative retry", () => {
  assert.equal(retryMode("failed"), "transition");
  assert.equal(retryMode("retrying"), "replay");
  assert.equal(retryMode("queued"), "reject");
  assert.equal(retryMode("placed"), "reject");
  assert.equal(retryMode("dispatched"), "reject");
  assert.equal(retryMode("running"), "reject");
  assert.equal(retryMode("ready"), "reject");
});
