import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRIAL_CONVERSION_MODE,
  PRODUCTION_POOL,
  TRIAL_CONVERSION_MODES,
  TRIAL_CONVERSION_STATES,
  parseTrialConversionApprovalInput,
  parseTrialConversionRequestInput,
  productionSlugForConversion,
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
  assert.equal(PRODUCTION_POOL, "production");
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

test("clean production approval derives a new bounded production identity", () => {
  const conversionId = "5174a3a9-594c-4c69-bacc-283078afe434";
  assert.deepEqual(
    parseTrialConversionApprovalInput(
      {},
      "Phase 5 Acceptance Trial",
      "phase5-20260905134005",
      conversionId,
    ),
    {
      production_name: "Phase 5 Acceptance Trial Production",
      production_slug: "phase5-20260905134005-prod-5174a3a9",
    },
  );

  const longSlug = productionSlugForConversion("a".repeat(64), conversionId);
  assert.ok(longSlug.length <= 64);
  assert.match(longSlug, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
});

test("clean production approval accepts an explicit safe identity and rejects unsafe slugs", () => {
  const conversionId = "5174a3a9-594c-4c69-bacc-283078afe434";
  assert.deepEqual(
    parseTrialConversionApprovalInput(
      {
        production_name: "Customer Production",
        production_slug: "customer-production",
      },
      "Trial",
      "trial-safe",
      conversionId,
    ),
    {
      production_name: "Customer Production",
      production_slug: "customer-production",
    },
  );

  assert.throws(
    () => parseTrialConversionApprovalInput(
      { production_slug: "unsafe slug" },
      "Trial",
      "trial-safe",
      conversionId,
    ),
    /invalid_production_slug/,
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
