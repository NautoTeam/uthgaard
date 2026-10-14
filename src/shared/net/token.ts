import { SignJWT, jwtVerify } from "jose";

/** Game-server audience. Better Auth sessions never travel to the world process. */
export const GAME_TOKEN_AUD = "caldrenmoor";

const ALG = "HS256";

function key(secret: string) {
  return new TextEncoder().encode(secret);
}

/** Five-minute HS256 token. `sub` is the Better Auth user id. */
export async function signGameToken(secret: string, user: { id: string; name: string }): Promise<string> {
  const name = user.name.trim().slice(0, 24) || "Hero";
  return new SignJWT({ name })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.id)
    .setAudience(GAME_TOKEN_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key(secret));
}

export async function verifyGameToken(
  secret: string,
  token: string,
): Promise<{ userId: string; name: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: [ALG],
      audience: GAME_TOKEN_AUD,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: "5 minutes",
    });
    const userId = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!userId || userId.length > 128) return null;
    const raw = typeof payload.name === "string" ? payload.name.trim().slice(0, 24) : "";
    return { userId, name: raw || "Hero" };
  } catch {
    return null;
  }
}

/** What `POST /api/game/token` returns after the Better Auth session check. */
export async function issueGameToken(
  user: { id: string; name: string } | null,
  secret: string | null,
): Promise<{ status: number; body: { token: string } | { error: string } }> {
  if (!user?.id) return { status: 401, body: { error: "Unauthorized" } };
  if (!secret) return { status: 503, body: { error: "Game token secret is not set" } };
  return { status: 200, body: { token: await signGameToken(secret, user) } };
}
