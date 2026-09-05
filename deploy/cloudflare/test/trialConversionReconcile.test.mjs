import test from "node:test";
import assert from "node:assert/strict";
import { conversionStateForProvisioningState } from "../src/trialConversionReconcile.ts";

test("production provisioning states map to bounded conversion states", () => {
  assert.equal(conversionStateForProvisioningState("queued"), null);
  assert.equal(conversionStateForProvisioningState("placed"), "provisioning");
  assert.equal(conversionStateForProvisioningState("dispatched"), "provisioning");
  assert.equal(conversionStateForProvisioningState("running"), "provisioning");
  assert.equal(conversionStateForProvisioningState("retrying"), "provisioning");
  assert.equal(conversionStateForProvisioningState("ready"), "ready");
  assert.equal(conversionStateForProvisioningState("failed"), "failed");
  assert.equal(conversionStateForProvisioningState("unknown"), null);
});
