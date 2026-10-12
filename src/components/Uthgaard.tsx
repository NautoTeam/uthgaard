import { useEffect, useState } from "react";
import { mountIsle, type IsleProfile } from "@/client/isle";
import { deleteSave, listSaves, type CharacterSave } from "@/client/localSave";
import { BASE_CLASSES, CREATABLE_RACES, classAllowed, classDenied, type BaseClass, type Race } from "@/game/types";

export function Uthgaard() {
  const [run, setRun] = useState<IsleProfile | null>(null);
  if (!run) return <Gate onEnter={setRun} />;
  return <Isle profile={run} />;
}

function Gate({ onEnter }: { onEnter: (profile: IsleProfile) => void }) {
  const [name, setName] = useState("Hero");
  const [race, setRace] = useState<Race>("Human");
  const [path, setPath] = useState<BaseClass>("Fighter");
  const [saves, setSaves] = useState<CharacterSave[]>([]);
  const [block, setBlock] = useState("");
  const locked = !classAllowed(race, path);

  useEffect(() => {
    setSaves(listSaves());
  }, []);

  function enter(next?: CharacterSave) {
    onEnter({
      username: (next?.username ?? name).trim().slice(0, 16) || "Hero",
      race: next?.race ?? race,
      baseClass: next?.baseClass ?? path,
    });
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
        enter();
      }}
    >
      <div className="login-create">
      <h1>Caldrenmoor</h1>
      <p className="sub">Havens of the Reach</p>
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
      <button id="joinBtn" type="submit" disabled={locked}>
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
              <button type="button" className="save-continue" onClick={() => enter(s)}>
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
      <canvas id="view" />
      <div id="clickDebug" />
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
          <div id="trainTitle">Eadric</div>
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
          <div id="shopTitle">Marta</div>
          <p id="shopGold">Gold 0</p>
          <div id="shopStock" />
          <div id="shopBag" />
          <button id="shopClose" type="button">
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
              <input id="clickDebugToggle" type="checkbox" defaultChecked />
              Show last click
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
        <div id="messages" />
        <input id="chatInput" placeholder="Say something…" enterKeyHint="send" />
      </div>
    </div>
  );
}
