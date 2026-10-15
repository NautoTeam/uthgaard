import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateAfterClose, worldMayStart, type LinkGate } from "./remote.ts";

describe("online only", () => {
  it("never starts the world from a socket close", () => {
    for (const code of [1000, 1006, 4400, 4401, 4409, 1011]) {
      const gate = gateAfterClose(code);
      assert.equal(worldMayStart(gate), false);
      assert.notEqual(gate, "online");
    }
  });

  it("4409 stays on the gate and 4401 returns to sign-in", () => {
    assert.equal(gateAfterClose(4409), "elsewhere");
    assert.equal(gateAfterClose(4401), "sign-in");
    assert.equal(gateAfterClose(1006), "unavailable");
  });

  it("the world starts only after welcome", () => {
    const gates: LinkGate[] = ["connecting", "unavailable", "elsewhere", "sign-in", "online"];
    assert.deepEqual(gates.filter(worldMayStart), ["online"]);
  });
});
