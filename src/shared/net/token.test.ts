import assert from "node:assert/strict";
import { test } from "node:test";
import { issueGameToken } from "./token";

const SECRET = "test-secret-test-secret-test-secret";

test("an unverified session is refused a game token", async () => {
  const refused = await issueGameToken({ id: "user-1", name: "Ada", emailVerified: false }, SECRET);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: "Email not verified" });
  const allowed = await issueGameToken({ id: "user-1", name: "Ada", emailVerified: true }, SECRET);
  assert.equal(allowed.status, 200);
  assert.equal("token" in allowed.body, true);
});
