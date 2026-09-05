import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProductionPlacementInput,
  productionExecutionEnabled,
} from "../src/productionPlacement.ts";

test("production placement requires an explicit confirmation and node id", () => {
  assert.deepEqual(
    parseProductionPlacementInput({
      confirm_production_placement: true,
      node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    }),
    {
      confirm_production_placement: true,
      node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    },
  );

  assert.throws(
    () => parseProductionPlacementInput({
      node_id: "92ab2a30-28dc-4b29-b943-9ae8548088b3",
    }),
    /production_placement_confirmation_required/,
  );

  assert.throws(
    () => parseProductionPlacementInput({
      confirm_production_placement: true,
      node_id: "trial-node",
    }),
    /invalid_production_node_id/,
  );
});

test("production execution is disabled unless the server explicitly opts in", () => {
  assert.equal(productionExecutionEnabled(), false);
  assert.equal(productionExecutionEnabled(""), false);
  assert.equal(productionExecutionEnabled("1"), false);
  assert.equal(productionExecutionEnabled("false"), false);
  assert.equal(productionExecutionEnabled(" TRUE "), true);
});
