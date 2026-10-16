import { useEffect, useState } from "react";
import { mountIsle, type IsleProfile } from "@/client/isle";
import { BASE_CLASSES, CREATABLE_RACES, classAllowed, classDenied, type BaseClass, type Race } from "@/game/types";
import { deleteCharacterSlot, fetchCharacterSlots, type CharacterSlotView } from "@/game/remote";
import { authClient, signOut } from "@/lib/auth/client";
import { PASSWORD_RULE, VERIFY_RETURN_URL, passwordProblem } from "@/lib/auth/account-policy";

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

function heroSprite(race: string) {
  const key = race.toLowerCase();
  if (key === "human") return "/sprites/anim/human-base-idle-0.png";
  if (key === "minotaur") return "/sprites/anim/minotaur-base-idle-0.png";
  if (key === "elf") return "/sprites/anim/elf-walk-0.png";
  if (key === "marshwarden") return "/sprites/anim/marshwarden-walk-0.png";
  return `/sprites/${key}.png`;
}

function createErrorText(reason: string) {
  if (reason === "name_taken") return "That name is taken.";
  if (reason === "slot_taken") return "That character slot is taken.";
  if (reason === "bad_slot") return "Pick a character slot.";
  if (reason === "bad_create") return "That hero cannot be created.";
  return reason;
}

function Gate({ onEnter, error }: { onEnter: (profile: IsleProfile) => void; error?: string }) {
  const [name, setName] = useState("Hero");
  const [race, setRace] = useState<Race>("Human");
  const [path, setPath] = useState<BaseClass>("Fighter");
  const [creating, setCreating] = useState<number | null>(null);
  const [confirmSlot, setConfirmSlot] = useState<number | null>(null);
  const [slots, setSlots] = useState<Array<CharacterSlotView | null>>([null, null, null]);
  const [slotsNote, setSlotsNote] = useState("");
  const [block, setBlock] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [authMode, setAuthMode] = useState<"in" | "up" | "verify">("in");
  const [pendingEmail, setPendingEmail] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const { data: session, isPending } = authClient.useSession();
  const email = session?.user?.email ?? "";
  const verified = session?.user?.emailVerified === true;
  const locked = !classAllowed(race, path);
  const verifyEmail = pendingEmail || email;
  const showingVerify = !verified && Boolean(email || authMode === "verify");

  useEffect(() => {
    if (!verified) return;
    let gone = false;
    setSlotsNote("");
    void fetchCharacterSlots().then((result) => {
      if (gone) return;
      if (!result.ok) {
        setSlotsNote(result.reason);
        return;
      }
      setSlots(result.slots);
    });
    return () => {
      gone = true;
    };
  }, [verified, error]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setTimeout(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [resendIn]);

  useEffect(() => {
    if (verified) setAuthMode("in");
  }, [verified]);

  async function enter(next: { username: string; race: Race; baseClass: BaseClass; slot: number; create: boolean }) {
    let signedIn = email;
    let emailVerified = verified;
    try {
      const fresh = await authClient.getSession();
      const user = fresh.data?.user;
      if (typeof user?.email === "string") signedIn = user.email;
      else if (fresh.data == null) signedIn = "";
      emailVerified = user?.emailVerified === true;
    } catch {
      /* keep the session already on screen */
    }
    if (!signedIn) {
      setAuthError("Sign in to enter the village.");
      return;
    }
    if (!emailVerified) {
      setPendingEmail(signedIn);
      setAuthMode("verify");
      setAuthError("");
      return;
    }
    onEnter(next);
  }

  async function refreshSlots() {
    const result = await fetchCharacterSlots();
    if (!result.ok) {
      setSlotsNote(result.reason);
      return;
    }
    setSlotsNote("");
    setSlots(result.slots);
  }

  async function removeSlot(slot: number) {
    setBusy(true);
    setSlotsNote("");
    try {
      const result = await deleteCharacterSlot(slot);
      if (!result.ok) {
        setSlotsNote(result.reason || "Could not delete that hero.");
        return;
      }
      setConfirmSlot(null);
      await refreshSlots();
    } finally {
      setBusy(false);
    }
  }

  function showAuthError(error: { message?: string; code?: string } | null | undefined) {
    const code = error?.code ?? "";
    const message = error?.message?.trim() || "That didn't work.";
    if (code === "EMAIL_NOT_VERIFIED" || /not verified/i.test(message)) {
      setPendingEmail(accountEmail.trim());
      setAuthMode("verify");
      setAuthError("");
      return;
    }
    if (code === "PASSWORD_TOO_SHORT" || /too short/i.test(message)) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    if (code === "PASSWORD_TOO_LONG" || /too long/i.test(message)) {
      setAuthError("Password must be at most 128 characters.");
      return;
    }
    if (code === "INVALID_EMAIL" || /invalid email/i.test(message)) {
      setAuthError("Enter a valid email.");
      return;
    }
    if (code === "INVALID_EMAIL_OR_PASSWORD") {
      setAuthError("That email and password don't match.");
      return;
    }
    if (code === "TOO_MANY_REQUESTS" || /too many|rate limit/i.test(message)) {
      setResendIn((n) => (n > 0 ? n : 60));
      setAuthError("Wait a moment before sending another link.");
      return;
    }
    setAuthError(message.length > 140 ? `${message.slice(0, 137)}…` : message);
  }

  async function submitAccount(mode: "in" | "up") {
    const mail = accountEmail.trim();
    if (!mail || !mail.includes("@")) {
      setAuthError("Enter a valid email.");
      return;
    }
    if (mode === "up") {
      const problem = passwordProblem(password, confirm);
      if (problem) {
        setAuthError(problem);
        return;
      }
    } else if (!password) {
      setAuthError("Enter your password.");
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
              callbackURL: VERIFY_RETURN_URL,
            })
          : await authClient.signIn.email({ email: mail, password });
      if (result.error) {
        showAuthError(result.error);
        return;
      }
      setPassword("");
      setConfirm("");
      if (mode === "up") {
        if (result.data?.user?.emailVerified === true) {
          await authClient.getSession();
          return;
        }
        setPendingEmail(mail);
        setAuthMode("verify");
        return;
      }
      await authClient.getSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : "That didn't work.";
      setAuthError(message.length > 140 ? `${message.slice(0, 137)}…` : message);
    } finally {
      setBusy(false);
    }
  }

  async function resendLink() {
    const mail = verifyEmail.trim();
    if (!mail || busy || resendIn > 0) return;
    setBusy(true);
    setAuthError("");
    try {
      const result = await authClient.sendVerificationEmail({
        email: mail,
        callbackURL: VERIFY_RETURN_URL,
      });
      if (result.error) {
        showAuthError(result.error);
        return;
      }
      setResendIn(60);
    } catch (err) {
      const message = err instanceof Error ? err.message : "That didn't work.";
      setAuthError(message.length > 140 ? `${message.slice(0, 137)}…` : message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(mode: "in" | "up") {
    setAuthMode(mode);
    setAuthError("");
    setConfirm("");
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
        if (creating == null) return;
        if (!classAllowed(race, path)) {
          setBlock(classDenied(race, path));
          return;
        }
        setBlock("");
        void enter({
          username: name.trim().slice(0, 16) || "Hero",
          race,
          baseClass: path,
          slot: creating,
          create: true,
        });
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
        <h2>
          {verified ? "Account" : showingVerify ? "Check your email to verify" : authMode === "up" ? "Register" : "Sign in"}
        </h2>
        {isPending ? (
          <p className="account-net">…</p>
        ) : verified ? (
          <>
            <p className="account-who">Signed in as {email}</p>
            <button type="button" disabled={busy} onClick={() => void leaveAccount()}>
              Sign out
            </button>
          </>
        ) : showingVerify ? (
          <>
            <p className="account-who">
              Check your email to verify{verifyEmail ? ` ${verifyEmail}` : ""}.
            </p>
            <button type="button" disabled={busy || resendIn > 0 || !verifyEmail} onClick={() => void resendLink()}>
              {resendIn > 0 ? `Resend link (${resendIn}s)` : "Resend link"}
            </button>
            <button type="button" className="account-switch" disabled={busy} onClick={() => switchMode("in")}>
              Use a different email
            </button>
            {email && (
              <button type="button" disabled={busy} onClick={() => void leaveAccount()}>
                Sign out
              </button>
            )}
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
                onChange={(e) => {
                  setAccountEmail(e.target.value);
                  setAuthError("");
                }}
              />
            </label>
            <label>
              Password
              <input
                id="accountPassword"
                type="password"
                autoComplete={authMode === "up" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setAuthError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && authMode === "in") {
                    e.preventDefault();
                    void submitAccount("in");
                  }
                }}
              />
            </label>
            {authMode === "up" && (
              <>
                <p className="account-rule">{PASSWORD_RULE}</p>
                <label>
                  Confirm password
                  <input
                    id="accountConfirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value);
                      setAuthError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitAccount("up");
                      }
                    }}
                  />
                </label>
              </>
            )}
            <div className="account-actions">
              {authMode === "in" ? (
                <button type="button" disabled={busy} onClick={() => void submitAccount("in")}>
                  Sign in
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void submitAccount("up")}>
                  Create account
                </button>
              )}
            </div>
            <button
              type="button"
              className="account-switch"
              disabled={busy}
              onClick={() => switchMode(authMode === "up" ? "in" : "up")}
            >
              {authMode === "up" ? "Already have an account? Sign in" : "Need an account? Register"}
            </button>
          </>
        )}
        {authError && <p className="account-reason">{authError}</p>}
      </div>
      {verified && (
        <>
          <div className="slot-row">
            {slots.map((hero, slot) =>
              hero ? (
                <div className="slot-frame" key={slot}>
                  <img src={heroSprite(hero.race)} alt="" />
                  <b>{hero.name}</b>
                  <span>
                    {hero.race} {hero.prestigeClass || hero.baseClass}
                  </span>
                  <span>Lv {hero.level}</span>
                  <button
                    type="button"
                    disabled={busy || isPending}
                    onClick={() =>
                      void enter({
                        username: hero.name,
                        race: hero.race as Race,
                        baseClass: hero.baseClass as BaseClass,
                        slot,
                        create: false,
                      })
                    }
                  >
                    Play
                  </button>
                  {confirmSlot === slot ? (
                    <button type="button" className="slot-delete" disabled={busy} onClick={() => void removeSlot(slot)}>
                      Confirm delete
                    </button>
                  ) : (
                    <button type="button" className="slot-delete" disabled={busy} onClick={() => setConfirmSlot(slot)}>
                      Delete
                    </button>
                  )}
                </div>
              ) : (
                <button
                  key={slot}
                  type="button"
                  className={`slot-frame slot-empty${creating === slot ? " on" : ""}`}
                  aria-label={`Create a hero in slot ${slot + 1}`}
                  onClick={() => {
                    setCreating(slot);
                    setConfirmSlot(null);
                    setBlock("");
                  }}
                >
                  +
                </button>
              ),
            )}
          </div>
          {slotsNote && <p className="path-block">{slotsNote}</p>}
          {creating != null && (
            <>
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
              <button id="joinBtn" type="submit" disabled={locked || isPending}>
                Create hero
              </button>
              <button type="button" className="account-switch" onClick={() => setCreating(null)}>
                Cancel
              </button>
            </>
          )}
        </>
      )}
      </div>
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
      <canvas id="view" tabIndex={0} />
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
