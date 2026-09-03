import test from "node:test";
import assert from "node:assert/strict";
import { trialCleanupRetryEligibility } from "../src/trialCleanupAdmin.ts";

function failedTrialCleanup(overrides = {}) {
  return {
    id: "cleanup-1",
    tenant_id: "tenant-1",
    node_id: "node-1",
    database_name: "dsx_restaurant_trial_1",
    state: "failed",
    error_code: "operation_lease_expired",
    tenant_status: "failed",
    trial_state: "failed",
    assigned_node_id: "node-1",
    tenant_database_name: "dsx_restaurant_trial_1",
    ...overrides,
  };
}

test("trial cleanup retry requires exact failed identity", () => {
  assert.equal(trialCleanupRetryEligibility(failedTrialCleanup()), null);
  assert.equal(
    trialCleanupRetryEligibility(failedTrialCleanup({ state: "running" })),
    "trial_cleanup_retry_requires_failed_job",
  );
  assert.equal(
    trialCleanupRetryEligibility(failedTrialCleanup({ trial_state: "active" })),
    "trial_cleanup_retry_tenant_not_failed",
  );
  assert.equal(
    trialCleanupRetryEligibility(failedTrialCleanup({ assigned_node_id: "node-other" })),
    "trial_cleanup_retry_node_mismatch",
  );
  assert.equal(
    trialCleanupRetryEligibility(failedTrialCleanup({ tenant_database_name: "other_db" })),
    "trial_cleanup_retry_database_mismatch",
  );
});
