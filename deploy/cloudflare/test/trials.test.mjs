import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTrialRequestInput,
  TRIAL_DURATION_DAYS,
  TRIAL_POOL,
  trialExpiryFrom,
  trialHostname,
} from "../src/trials.ts";

test("trial request is fixed to a known sector and safe idempotency key", () => {
  assert.deepEqual(
    parseTrialRequestInput({
      name: "Demo Restaurant",
      slug: "demo-restaurant",
      sector: "restaurant",
      idempotency_key: "trial:website:0001",
    }),
    {
      name: "Demo Restaurant",
      slug: "demo-restaurant",
      sector: "restaurant",
      idempotency_key: "trial:website:0001",
    },
  );

  assert.throws(
    () => parseTrialRequestInput({
      name: "Bad",
      slug: "bad slug",
      sector: "restaurant",
      idempotency_key: "trial:website:0002",
    }),
    /invalid_tenant_slug/,
  );
  assert.throws(
    () => parseTrialRequestInput({
      name: "Bad",
      slug: "safe-slug",
      sector: "unknown",
      idempotency_key: "trial:website:0003",
    }),
    /invalid_sector/,
  );
  assert.throws(
    () => parseTrialRequestInput({
      name: "Bad",
      slug: "safe-slug",
      sector: "cafe",
      idempotency_key: "short",
    }),
    /invalid_idempotency_key/,
  );
});

test("trial policy is fixed to the trial pool and three days", () => {
  assert.equal(TRIAL_POOL, "trial");
  assert.equal(TRIAL_DURATION_DAYS, 3);
  assert.equal(
    trialExpiryFrom("2026-09-04T00:00:00.000Z"),
    "2026-09-07T00:00:00.000Z",
  );
});

test("trial hostname is derived only from configured safe base domain", () => {
  assert.equal(trialHostname("demo-restaurant", "trials.dsxpos.com"), "demo-restaurant.trials.dsxpos.com");
  assert.equal(trialHostname("demo-restaurant", ".trials.dsxpos.com."), "demo-restaurant.trials.dsxpos.com");
  assert.equal(trialHostname("demo-restaurant"), null);
  assert.equal(trialHostname("demo-restaurant", "http://trials.dsxpos.com"), null);
});
