import type { BaseClass, Race } from "../shared/content/catalog";

/** The creation screen's choice. Piece 3 sends this only after `need_create`. */
export interface HelloChoice {
  username: string;
  race: Race;
  baseClass: BaseClass;
}

export function gameHello(token: string, choice?: HelloChoice) {
  if (!choice) return { t: "hello" as const, token };
  return {
    t: "hello" as const,
    token,
    create: {
      name: choice.username.trim().slice(0, 16),
      race: choice.race,
      baseClass: choice.baseClass,
    },
  };
}

/**
 * The server has no row yet. Send the same token again with the name, race,
 * and class the player already picked on the creation screen.
 */
export function helloAfterNeedCreate(
  token: string,
  reason: string,
  choice: HelloChoice,
): ReturnType<typeof gameHello> | null {
  if (reason !== "need_create") return null;
  const name = choice.username.trim();
  if (name.length < 2) return null;
  return gameHello(token, { ...choice, username: name });
}

/** Socket hook: on `need_create`, write the creation-screen hello back to the server. */
export function answerNeedCreate(
  msg: { t?: string; reason?: string },
  token: string,
  choice: HelloChoice,
  send: (body: ReturnType<typeof gameHello>) => void,
) {
  if (msg.t !== "error") return;
  const next = helloAfterNeedCreate(token, msg.reason ?? "", choice);
  if (next) send(next);
}
