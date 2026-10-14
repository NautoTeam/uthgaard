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
  assert.equal(claims?.userId, "user-1");
  assert.equal(claims?.name, "Ada");
  assert.match(claims?.jti ?? "", /^[0-9a-f-]{36}$/i);
  assert.ok((claims?.exp ?? 0) > Date.now() / 1000 + 60);
  const again = await verifyGameToken(SECRET, issued.body.token);
  assert.equal(again?.jti, claims?.jti);
});

test("the wrong audience and a stale token are rejected", async () => {
  const key = new TextEncoder().encode(SECRET);
  const other = await new SignJWT({ name: "Ada" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setAudience("somewhere-else")
    .setJti("11111111-1111-1111-1111-111111111111")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
  assert.equal(await verifyGameToken(SECRET, other), null);

  const expired = await new SignJWT({ name: "Ada" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setAudience(GAME_TOKEN_AUD)
    .setJti("22222222-2222-2222-2222-222222222222")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(key);
  assert.equal(await verifyGameToken(SECRET, expired), null);
});
