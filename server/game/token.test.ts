import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";
import { GAME_TOKEN_AUD, issueGameToken, verifyGameToken } from "../../src/shared/net/token";

const SECRET = "test-secret-test-secret-test-secret";

test("a session mints a five-minute caldrenmoor token", async () => {
  const missing = await issueGameToken(null, SECRET);
  assert.equal(missing.status, 401);
  const unset = await issueGameToken({ id: "user-1", name: "Ada" }, null);
  assert.equal(unset.status, 503);
  const issued = await issueGameToken({ id: "user-1", name: "Ada" }, SECRET);
  assert.equal(issued.status, 200);
  assert.ok("token" in issued.body);
  const claims = await verifyGameToken(SECRET, issued.body.token);
  assert.deepEqual(claims, { userId: "user-1", name: "Ada" });
});

test("the wrong audience and a stale token are rejected", async () => {
  const key = new TextEncoder().encode(SECRET);
  const other = await new SignJWT({ name: "Ada" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setAudience("somewhere-else")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
  assert.equal(await verifyGameToken(SECRET, other), null);

  const expired = await new SignJWT({ name: "Ada" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setAudience(GAME_TOKEN_AUD)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(key);
  assert.equal(await verifyGameToken(SECRET, expired), null);
});
