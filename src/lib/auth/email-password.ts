/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * Verification mail goes out through Resend (`RESEND_API_KEY`, `EMAIL_FROM`).
 * `requireEmailVerification` and `sendOnSignUp` turn on only when
 * `REQUIRE_EMAIL_VERIFICATION` is `"true"` and both mail env vars are set.
 * Otherwise sign-up marks the address verified so the account still works
 * after verification is turned on later.
 */
import { Resend } from "resend";
import { VERIFY_RETURN_URL } from "./account-policy";

export const emailAndPasswordEnabled = true;

export { VERIFY_RETURN_URL };

const DEFAULT_FROM = "Caldrenmoor <onboarding@resend.dev>";

type VerificationEnv = {
  REQUIRE_EMAIL_VERIFICATION?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

/** True only when verification is explicitly requested and mail can be sent. */
export function emailVerificationRequired(env: VerificationEnv = process.env): boolean {
  return (
    env.REQUIRE_EMAIL_VERIFICATION === "true" &&
    Boolean(env.RESEND_API_KEY?.trim()) &&
    Boolean(env.EMAIL_FROM?.trim())
  );
}

export function isEmailSignUpPath(path: string | undefined): boolean {
  return path === "/sign-up/email" || Boolean(path?.endsWith("/sign-up/email"));
}

/**
 * `true` when a create should persist `emailVerified`. Undefined leaves the
 * caller's value alone (verification on, or not an email sign-up).
 */
export function emailVerifiedOnCreate(path: string | undefined, required: boolean): true | undefined {
  if (required || !isEmailSignUpPath(path)) return undefined;
  return true;
}

const verificationRequired = emailVerificationRequired();

/** What `/api/game/token` should pass through. Unverified sessions 403 only while verification is on. */
export function sessionEmailVerifiedForToken(emailVerified: boolean, required = verificationRequired): boolean {
  return required ? emailVerified : true;
}

function escapeAttr(value: string) {
  return value.replace(/[&"<>]/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === '"') return "&" + "quot;";
    if (ch === "<") return "&" + "lt;";
    return "&" + "gt;";
  });
}

export async function sendVerificationEmail(data: { user: { email: string }; url: string }) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new Error("Email is not configured.");
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  const resend = new Resend(key);
  const result = await resend.emails.send({
    from,
    to: data.user.email,
    subject: "Verify your Caldrenmoor email",
    text: `Verify your email to enter Caldrenmoor: ${data.url}`,
    html: `<p>Verify your email to enter Caldrenmoor.</p><p><a href="${escapeAttr(data.url)}">Verify email</a></p>`,
  });
  if (result.error) throw new Error(result.error.message || "The verification email could not be sent.");
}

export const emailAuth = {
  emailAndPassword: {
    enabled: true as const,
    requireEmailVerification: verificationRequired,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  emailVerification: {
    sendOnSignUp: verificationRequired,
    autoSignInAfterVerification: true,
    sendVerificationEmail,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (
          _user: Record<string, unknown>,
          context: { path?: string } | null,
        ) => {
          if (emailVerifiedOnCreate(context?.path, verificationRequired) !== true) return;
          return { data: { emailVerified: true } };
        },
      },
    },
  },
};
