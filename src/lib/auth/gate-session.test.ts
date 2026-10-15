import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveGateSessionUser } from "./gate-session.server.ts";

describe("resolveGateSessionUser", () => {
  it("keeps an email session when x-grok-identity is a different user", () => {
    const decision = resolveGateSessionUser({
      existingUserId: "email-user",
      accounts: [{ providerId: "credential", accountId: "email-user" }],
      identitySub: "grok-viewer",
    });
    assert.deepEqual(decision, {
      action: "keep",
      userId: "email-user",
      gate: false,
      email: true,
    });
  });

  it("adopts the grok viewer only when there is no session", () => {
    const decision = resolveGateSessionUser({
      existingUserId: null,
      accounts: null,
      identitySub: "grok-viewer",
    });
    assert.deepEqual(decision, { action: "adopt" });
  });
});
