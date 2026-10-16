/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * `emailAndPasswordEnabled` turns the block on. Verification mail goes out
 * through Resend (`RESEND_API_KEY`, optional `EMAIL_FROM`).
 */
import { Resend } from "resend";
import { VERIFY_RETURN_URL } from "./account-policy";

export const emailAndPasswordEnabled = true;

export { VERIFY_RETURN_URL };

const DEFAULT_FROM = "Caldrenmoor <onboarding@resend.dev>";

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
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail,
  },
};
