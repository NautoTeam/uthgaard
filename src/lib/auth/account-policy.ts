/** Where a verification link sends the player after the email is confirmed. */
export const VERIFY_RETURN_URL = "https://drum-lake-garden-apple.grok.me";

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Shown under the register password field. Matches the server limits. */
export const PASSWORD_RULE = "Use 8 to 128 characters.";

/** Empty when the password is acceptable. `confirm` is checked only when passed. */
export function passwordProblem(password: string, confirm?: string): string {
  if (password.length < PASSWORD_MIN) return "Password must be at least 8 characters.";
  if (password.length > PASSWORD_MAX) return "Password must be at most 128 characters.";
  if (confirm !== undefined && password !== confirm) return "Passwords do not match.";
  return "";
}
