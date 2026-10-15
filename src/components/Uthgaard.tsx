import { useEffect, useState } from "react";
import { mountIsle, type IsleProfile } from "@/client/isle";
import { deleteSave, listSaves, type CharacterSave } from "@/client/localSave";
import { BASE_CLASSES, CREATABLE_RACES, classAllowed, classDenied, type BaseClass, type Race } from "@/game/types";
import { authClient, signOut } from "@/lib/auth/client";

export function Uthgaard() {
  const [run, setRun] = useState<IsleProfile | null>(null);
  const [createError, setCreateError] = useState("");
  if (!run) {
    return (
      <Gate
        error={createError}
        onEnter={(profile) => {
          setCreateError("");
          setRun({
            ...profile,
            onCreateError: (reason) => {
              setCreateError(createErrorText(reason));
              setRun(null);
            },
            onSignOut: () => setRun(null),
          });
        }}
      />
    );
  }
  return <Isle profile={run} />;
}

function createErrorText(reason: string) {
  if (reason === "name_taken") return "That name is taken.";
  if (reason === "bad_create") return "That hero cannot be created.";
  return reason;
}

function Gate({ onEnter, error }: { onEnter: (profile: IsleProfile) => void; error?: string }) {
  const [name, setName] = useState("Hero");
  const [race, setRace] = useState<Race>("Human");
  const [path, setPath] = useState<BaseClass>("Fighter");
  const [saves, setSaves] = useState<CharacterSave[]>([]);
  const [block, setBlock] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: session, isPending } = authClient.useSession();
  const email = session?.user?.email ?? "";
  const locked = !classAllowed(race, path);

  useEffect(() => {
    setSaves(listSaves());
  }, []);

  async function enter(next?: CharacterSave) {
    let signedIn = email;
    try {
      const fresh = await authClient.getSession();
      const mail = fresh.data?.user?.email;
      if (typeof mail === "string") signedIn = mail;
      else if (fresh.data == null) signedIn = "";
    } catch {
      /* keep the session already on screen */
    }
    if (!signedIn) {
      setAuthError("Sign in to enter the village.");
      return;
    }
    onEnter({
      username: (next?.username ?? name).trim().slice(0, 16) || "Hero",
      race: next?.race ?? race,
      baseClass: next?.baseClass ?? path,
    });
  }

  async function submitAccount(mode: "in" | "up") {
    const mail = accountEmail.trim();
    if (!mail || !password) {
      setAuthError("Enter an email and a password.");
      return;
    }
    setBusy(true);
    setAuthError("");
    try {
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email: mail,
              password,
              name: mail.split("@")[0]?.replace(/[^\w .'-]/g, "").slice(0, 24) || "Hero",
            })
          : await authClient.signIn.email({ email: mail, password });
      if (result.error) {
        const message = result.error.message?.trim() || "That didn't work.";
        setAuthError(message.length > 140 ? `${message.slice(0, 137)}…` : message);
        return;
      }
      setPassword("");
      await authClient.getSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : "That didn't work.";
      setAuthError(message.length > 140 ? `${message.slice(0, 137)}…` : message);
    } finally {
      setBusy(false);
    }
  }

  async function leaveAccount() {
    setBusy(true);
    setAuthError("");
    try {
      await signOut("/");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign-out failed.");
      setBusy(false);
    }
  }

  return (
    <form
      id="login"
      onSubmit={(e) => {
        e.preventDefault();
        if (!classAllowed(race, path)) {
          setBlock(classDenied(race, path));
          return;
        }
        setBlock("");
        void enter();
      }}
    >
      <div className="login-create">
      <h1>Caldrenmoor</h1>
      <p className="sub">Havens of the Reach</p>
      <div
        className="account-panel"
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
      >
        <h2>Sign in / Create account</h2>
        {isPending ? (
          <p className="account-net">…</p>
        ) : email ? (
          <>
            <p className="account-who">Signed in as {email}</p>
            <button type="button" disabled={busy} onClick={() => void leaveAccount()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <label>
              Email
              <input
                id="accountEmail"
                type="email"
                autoComplete="username"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                id="accountPassword"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitAccount("in");
                  }
                }}
              />
            </label>
            <div className="account-actions">
              <button type="button" disabled={busy} onClick={() => void submitAccount("in")}>
                Sign in
              </button>
              <button type="button" disabled={busy} onClick={() => void submitAccount("up")}>
                Create account
              </button>
            </div>
          </>
        )}
        {authError && <p className="account-reason">{authError}</p>}
      </div>
      <label>
        Name
        <input id="username" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Race
        <select
          id="race"
          value={race}
          onChange={(e) => {
            const next = e.target.value as Race;
            setRace(next);
            setBlock(classAllowed(next, path) ? "" : classDenied(next, path));
          }}
        >
          {CREATABLE_RACES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Path
        <select
          id="baseClass"
          value={path}
          onChange={(e) => {
            const next = e.target.value as BaseClass;
            setPath(next);
            setBlock(classAllowed(race, next) ? "" : classDenied(race, next));
          }}
        >
          {BASE_CLASSES.map((c) => {
            const reason = classDenied(race, c);
            return (
              <option key={c} value={c} disabled={!!reason}>
                {reason ? `${c} — closed` : c}
              </option>
            );
          })}
        </select>
      </label>
      {(locked || block) && <p className="path-block">{block || classDenied(race, path)}</p>}
      {error && (
        <p className="path-block" id="createError">
          {error}
        </p>
      )}
      <button id="joinBtn" type="submit" disabled={locked || !email || isPending}>
        Enter the Village
      </button>
      <p className="hint">
        Click a tile to walk. W moves up the screen, S down, A left, and D right.
        <span className="touch-only"> Drag the stick to walk.</span>
      </p>
      </div>
      {saves.length > 0 && (
        <div className="saves">
          {saves.map((s) => (
            <div className="save-row" key={s.username}>
              <button type="button" className="save-continue" disabled={!email || isPending} onClick={() => enter(s)}>
                Continue
                <small>
                  {s.username} · {s.race} {s.prestigeClass || s.baseClass} · Lv {s.level}
                </small>
              </button>
              <button
                type="button"
                className="save-delete"
                onClick={() => {
                  deleteSave(s.username);
                  setSaves(listSaves());
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

function Isle({ profile }: { profile: IsleProfile }) {
  useEffect(() => {
    const root = document.getElementById("game");
    if (!root) return;
    return mountIsle(root, profile);
  }, [profile]);

  return (
    <div id="game">
      <div id="linkGate">
        <div className="card">
          <p id="linkGateText">Connecting…</p>
          <button id="linkGateRetry" type="button" hidden>
            Retry
          </button>
        </div>
      </div>
      <canvas id="view" />
      <div id="clickDebug" hidden></div>
      <div id="debugHud" hidden>
        <label>
          Set level
          <input id="debugHudLevel" type="number" min={1} max={25} defaultValue={20} />
        </label>
        <button id="debugHudLevelBtn" type="button">
          Set level
        </button>
        <button id="debugGoldBtn" type="button">
          Give 200 gold
        </button>
        <button id="debugSpawnBtn" type="button">
          Spawn test mob
        </button>
        <button id="debugKillHudBtn" type="button">
          Kill me
        </button>
      </div>
      <div id="groupFrame" hidden />
      <div id="targetFrame" hidden></div>
      <div id="inviteToast" hidden>
        <p id="inviteText" />
        <button id="inviteAccept" type="button">
          Accept
        </button>
        <button id="inviteDecline" type="button">
          Decline
        </button>
      </div>
      <div id="guildToast" hidden>
        <p id="guildToastText" />
        <button id="guildAccept" type="button">
          Accept
        </button>
        <button id="guildDecline" type="button">
          Decline
        </button>
      </div>
      <div id="plotPrompt" hidden>
        <p id="plotPromptText" />
        <button id="plotPromptBtn" type="button">
          Plant Cornerstone
        </button>
      </div>
      <div id="ctxMenu" hidden />
      <div id="stats" />
      <div id="legend">
        W up the screen, S down, A left, D right. Click a tile to walk. Click a creature, then Space or Attack. Halls, trees, and water block you.
      </div>
      <div id="stick" aria-hidden="true">
        <div id="knob" />
      </div>
      <button id="talkBtn" type="button" hidden>
        Speak to Wayfarer
      </button>
      <div id="travel" hidden>
        <div id="travelPanel">
          <div id="travelTitle">Wayfarer</div>
          <p id="travelHint">The stones can carry you onward.</p>
          <div id="travelButtons" />
          <button id="travelClose" type="button">
            Stay
          </button>
        </div>
      </div>
      <div id="hotbar">
        {Array.from({ length: 8 }, (_, i) => (
          <button key={i} type="button" data-slot={i}>
            <i className="cd" />
            <b className="key">{i + 1}</b>
            <span className="nm">—</span>
          </button>
        ))}
      </div>
      <div id="skills">
        <button id="sheetBtn" type="button">
          Sheet
        </button>
        <button id="bagBtn" type="button">
          Inventory
        </button>
        <button id="promoteBtn" type="button" hidden>
          Promote
        </button>
        <button id="mapBtn" type="button">
          Map
        </button>
        <button id="guildBtn" type="button">
          Guild
        </button>
        <button id="chatToggle" type="button">
          Chat
        </button>
      </div>
      <div id="mapOverlay" hidden>
        <div id="mapPanel">
          <div id="mapTitle">The Reach</div>
          <canvas id="mapCanvas" width={640} height={640} />
          <button id="mapClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="bag" hidden>
        <div id="bagPanel">
          <div id="bagTitle">Inventory</div>
          <div id="dollSlots" />
          <div id="bagBody" />
          <button id="bagClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="train" hidden>
        <div id="trainPanel">
          <div id="trainTitle">Trainer</div>
          <p id="trainPoints">Training points 0</p>
          <div id="trainList" />
          <button id="trainPromote" type="button" hidden>
            Promote
          </button>
          <button id="trainClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="shop" hidden>
        <div id="shopPanel">
          <div id="shopTitle">Vendor</div>
          <p id="shopGold">Gold 0</p>
          <div id="shopStock" />
          <div id="shopBag" />
          <button id="shopClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="guild" hidden>
        <div id="guildPanel">
          <div id="guildTitle">Guild</div>
          <div id="guildBody" />
          <button id="guildClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="sheet" hidden>
        <div id="sheetPanel">
          <div id="sheetTitle">Character</div>
          <div id="sheetBody" />
          <div id="debugLevel" hidden>
            <label>
              Debug level
              <input id="debugLevelInput" type="number" min={1} max={25} defaultValue={10} />
            </label>
            <button id="debugLevelBtn" type="button">
              Debug: Set level
            </button>
            <button id="debugPlusBtn" type="button">
              Debug: +1 level
            </button>
            <button id="debugHpBtn" type="button">
              Debug: Set HP 1
            </button>
            <button id="debugKillBtn" type="button">
              Debug: Kill me
            </button>
            <label className="click-debug-toggle">
              <input id="clickDebugToggle" type="checkbox" />
              Show last click (`)
            </label>
          </div>
          <button id="sheetClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="death" hidden>
        <div id="deathPanel">
          <h2>You have fallen</h2>
          <p id="deathHint">A tombstone holds your gold. Respawn in the Village of Caldrenmoor under Grave Chill.</p>
          <button id="respawnBtn" type="button">
            Respawn in Caldrenmoor
          </button>
        </div>
      </div>
      <div id="chat">
        <div id="chatTabs">
          <button id="chatTabSay" type="button" className="on">
            Say
          </button>
          <button id="chatTabPvp" type="button">
            PvP
          </button>
          <button id="chatTabGuild" type="button">
            Guild
          </button>
        </div>
        <p id="bindLine" />
        <p id="netStatus" hidden />
        <div id="messages" />
        <div id="pvpMessages" hidden />
        <div id="guildMessages" hidden />
        <input id="chatInput" placeholder="Say something…" enterKeyHint="send" />
      </div>
    </div>
  );
}
