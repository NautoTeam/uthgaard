import { z } from "zod";

const id = z.string().max(64);
const finite = z.number().finite();

const move = z
  .object({
    op: z.literal("move"),
    x: finite,
    z: finite,
    rotation: finite,
  })
  .strict();

const attack = z
  .object({
    op: z.literal("attack"),
    targetId: id.nullable(),
  })
  .strict();

const skill = z
  .object({
    op: z.literal("skill"),
    name: id,
    targetId: id.nullable(),
  })
  .strict();

const travel = z
  .object({
    op: z.literal("travel"),
    cityId: id,
  })
  .strict();

const buy = z
  .object({
    op: z.literal("buy"),
    itemId: id,
  })
  .strict();

const sell = z
  .object({
    op: z.literal("sell"),
    itemId: id,
  })
  .strict();

const useItem = z
  .object({
    op: z.literal("useItem"),
    itemId: id,
  })
  .strict();

const equip = z
  .object({
    op: z.literal("equip"),
    itemId: id,
  })
  .strict();

const unequip = z
  .object({
    op: z.literal("unequip"),
    slot: id,
  })
  .strict();

const train = z
  .object({
    op: z.literal("train"),
    skillId: id,
  })
  .strict();

const promote = z
  .object({
    op: z.literal("promote"),
    cls: id,
  })
  .strict();

const chat = z
  .object({
    op: z.literal("chat"),
    msg: z.string().max(200),
  })
  .strict();

const respawn = z
  .object({
    op: z.literal("respawn"),
  })
  .strict();

const loot = z
  .object({
    op: z.literal("loot"),
    graveId: id,
  })
  .strict();

/** Client intents. No player id — the socket is the identity. Debug ops are absent. */
export const IntentSchema = z.discriminatedUnion("op", [
  move,
  attack,
  skill,
  travel,
  buy,
  sell,
  useItem,
  equip,
  unequip,
  train,
  promote,
  chat,
  respawn,
  loot,
]);

export type Intent = z.infer<typeof IntentSchema>;

const helloCreate = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(16)
      .regex(/^[A-Za-z0-9][A-Za-z0-9' -]*$/),
    race: z.string(),
    baseClass: z.string(),
    slot: z.number().int(),
  })
  .strict();

export const ClientMsg = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("hello"),
      token: z.string().min(20).max(2048),
      slot: z.number().int().optional(),
      create: helloCreate.optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal("intent"),
      seq: z.number().int().nonnegative(),
      intent: IntentSchema,
    })
    .strict(),
]);

export type ClientMsg = z.infer<typeof ClientMsg>;

const counts = z.record(z.string(), z.number());

const playerState = z
  .object({
    id: z.string(),
    username: z.string(),
    race: z.string(),
    baseClass: z.string(),
    prestigeClass: z.string(),
    level: z.number(),
    xp: z.number(),
    gold: z.number(),
    hp: z.number(),
    maxHp: z.number(),
    mana: z.number(),
    maxMana: z.number(),
    stamina: z.number(),
    maxStamina: z.number(),
    str: z.number(),
    dex: z.number(),
    con: z.number(),
    int: z.number(),
    spi: z.number(),
    x: z.number(),
    z: z.number(),
    rotation: z.number(),
    nextSwing: z.number(),
    inventory: counts,
    equipment: z.record(z.string(), z.string()),
    trainPoints: z.number(),
    skills: counts,
    hotbar: z.array(z.string()),
    cooldowns: counts,
    guardUntil: z.number(),
    wallUntil: z.number(),
    stealthUntil: z.number(),
    shroudUntil: z.number(),
    graveDropped: z.boolean(),
    attunedGates: z.array(z.string()).optional(),
  })
  .strict();

const monsterState = z
  .object({
    id: z.string(),
    type: z.string(),
    level: z.number(),
    hp: z.number(),
    maxHp: z.number(),
    x: z.number(),
    z: z.number(),
    homeX: z.number(),
    homeZ: z.number(),
    slotX: z.number(),
    slotZ: z.number(),
    targetId: z.string().nullable(),
    respawnAt: z.number(),
    nextHit: z.number(),
    snareUntil: z.number(),
  })
  .strict();

const graveState = z
  .object({
    id: z.string(),
    owner: z.string(),
    x: z.number(),
    z: z.number(),
    gold: z.number(),
    items: counts,
    born: z.number().optional(),
  })
  .strict();

export const PublicStateSchema = z
  .object({
    players: z.array(playerState),
    monsters: z.array(monsterState),
    graves: z.array(graveState),
    logs: z.array(z.string()),
  })
  .strict();

const actionResult = z
  .object({
    ok: z.boolean(),
    reason: z.string().optional(),
    dmg: z.number().optional(),
  })
  .strict();

export const ServerMsg = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("welcome"),
      playerId: z.string(),
    })
    .strict(),
  z
    .object({
      t: z.literal("ack"),
      seq: z.number().int().nonnegative(),
      result: actionResult,
    })
    .strict(),
  z
    .object({
      t: z.literal("snap"),
      tick: z.number().int().nonnegative(),
      /** Connected heroes, including ones outside this client's zone. */
      online: z.number().int().nonnegative(),
      state: PublicStateSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal("error"),
      reason: z.string(),
    })
    .strict(),
]);

export type ServerMsg = z.infer<typeof ServerMsg>;
