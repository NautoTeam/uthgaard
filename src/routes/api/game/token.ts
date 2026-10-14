import { createFileRoute } from "@tanstack/react-router";
import { auth, authConfigured } from "@/lib/auth/server";
import { issueGameToken } from "@/shared/net/token";

/** Better Auth session in, five-minute game token out. The world process never sees the cookie. */
export const Route = createFileRoute("/api/game/token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authConfigured) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const session = await auth.api.getSession({ headers: request.headers });
        const user = session?.user?.id
          ? { id: session.user.id, name: session.user.name ?? "" }
          : null;
        const secret = process.env.GAME_TOKEN_SECRET?.trim() || null;
        const result = await issueGameToken(user, secret);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
