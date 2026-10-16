import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emailVerificationRequired,
  emailVerifiedOnCreate,
  isEmailSignUpPath,
  sessionEmailVerifiedForToken,
} from "./email-password.ts";

const ready = {
  REQUIRE_EMAIL_VERIFICATION: "true",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Caldrenmoor <play@example.com>",
};

describe("email verification toggle", () => {
  it("stays off unless the flag and both mail env vars are set", () => {
    assert.equal(emailVerificationRequired({}), false);
    assert.equal(emailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "true" }), false);
    assert.equal(
      emailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "true", RESEND_API_KEY: "re_test" }),
      false,
    );
    assert.equal(
      emailVerificationRequired({
        REQUIRE_EMAIL_VERIFICATION: "true",
        RESEND_API_KEY: "  ",
        EMAIL_FROM: "play@example.com",
      }),
      false,
    );
    assert.equal(emailVerificationRequired({ ...ready, REQUIRE_EMAIL_VERIFICATION: "false" }), false);
    assert.equal(emailVerificationRequired(ready), true);
  });

  it("marks emailVerified only for sign-up while verification is off", () => {
    assert.equal(isEmailSignUpPath("/sign-up/email"), true);
    assert.equal(isEmailSignUpPath("/api/auth/sign-up/email"), true);
    assert.equal(emailVerifiedOnCreate("/sign-up/email", false), true);
    assert.equal(emailVerifiedOnCreate("/api/auth/sign-up/email", false), true);
    assert.equal(emailVerifiedOnCreate("/sign-up/email", true), undefined);
    assert.equal(emailVerifiedOnCreate("/callback/google", false), undefined);
  });

  it("403s an unverified session only while verification is on", () => {
    assert.equal(sessionEmailVerifiedForToken(false, false), true);
    assert.equal(sessionEmailVerifiedForToken(true, false), true);
    assert.equal(sessionEmailVerifiedForToken(false, true), false);
    assert.equal(sessionEmailVerifiedForToken(true, true), true);
  });
});
