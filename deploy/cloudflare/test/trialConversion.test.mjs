import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRIAL_CONVERSION_MODE,
  TRIAL_CONVERSION_MODES,
  TRIAL_CONVERSION_STATES,
  parseTrialConversionRequestInput,
} from "../src/trialConversion.ts";

test("trial conversion defaults to clean production provisioning", () => {
  assert.deepEqual(
    parseTrialConversionRequestInput({ idempotency_key: "convert:trial:0001" }),
    {
      idempotency_key: "convert:trial:0001",
      mode: "clean_production",
      confirm_data_promotion: false,
    },
  );
  assert.equal(DEFAULT_TRIAL_CONVERSION_MODE, "clean_production");
  assert.deepEqual([...TRIAL_CONVERSION_MODES], ["clean_production", "promote_trial_data"]);
});

test("trial data promotion must be explicit and confirmed", () => {
  assert.throws(
    () => parseTrialConversionRequestInput({
      idempotency_key: "convert:trial:0002",
      mode: "promote_trial_data",
    }),
    /data_promotion_confirmation_required/,
  );

  assert.deepEqual(
    parseTrialConversionRequestInput({
      idempotency_key: "convert:trial:0003",
      mode: "promote_trial_data",
      confirm_data_promotion: true,
    }),
    {
      idempotency_key: "convert:trial:0003",
      mode: "promote_trial_data",
      confirm_data_promotion: true,
    },
  );
});

test("trial conversion request rejects unsafe modes and keys", () => {
  assert.throws(
    () => parseTrialConversionRequestInput({
      idempotency_key: "short",
    }),
    /invalid_idempotency_key/,
  );
  assert.throws(
    () => parseTrialConversionRequestInput({
      idempotency_key: "convert:trial:0004",
      mode: "reuse_trial_silently",
    }),
    /invalid_conversion_mode/,
  );
});

test("trial conversion states are bounded", () => {
  assert.deepEqual([...TRIAL_CONVERSION_STATES], [
    "requested",
    "approved",
    "provisioning",
    "ready",
    "failed",
    "cancelled",
  ]);
});
