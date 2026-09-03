import test from "node:test";
import assert from "node:assert/strict";
import { isTrialDue, TRIAL_EXPIRATION_BATCH_SIZE } from "../src/trialExpiration.ts";

test("trial expiry scan is bounded", () => {
  assert.equal(TRIAL_EXPIRATION_BATCH_SIZE, 50);
});

test("only active ready trials at or past expiry are due", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  assert.equal(isTrialDue({ status: "ready", trial_state: "active", trial_expires_at: "2026-09-04T12:00:00.000Z" }, now), true);
  assert.equal(isTrialDue({ status: "ready", trial_state: "active", trial_expires_at: "2026-09-04T11:59:59.000Z" }, now), true);
  assert.equal(isTrialDue({ status: "ready", trial_state: "active", trial_expires_at: "2026-09-04T12:00:01.000Z" }, now), false);
  assert.equal(isTrialDue({ status: "suspended", trial_state: "expired", trial_expires_at: "2026-09-04T11:00:00.000Z" }, now), false);
  assert.equal(isTrialDue({ status: "ready", trial_state: "provisioning", trial_expires_at: "2026-09-04T11:00:00.000Z" }, now), false);
  assert.equal(isTrialDue({ status: "ready", trial_state: "active", trial_expires_at: null }, now), false);
});
