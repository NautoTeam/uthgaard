import { useEffect, useState } from "react";
import { mountIsle, type IsleProfile } from "@/client/isle";
import { deleteSave, listSaves, type CharacterSave } from "@/client/localSave";
import { BASE_CLASSES, RACES, classAllowed, type BaseClass, type Race } from "@/game/types";

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
          setBlock("Minotaurs cannot take Mage or Rogue.");
          return;
        }
        setBlock("");
        enter();
      }}
    >
      <div className="login-create">
      <h1>Uthgaard</h1>
      <p className="sub">Three cities on a wide reach</p>
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
            setBlock(classAllowed(next, path) ? "" : "Minotaurs cannot take Mage or Rogue.");
          }}
        >
          {RACES.map((r) => (
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
            setBlock(classAllowed(race, next) ? "" : "Minotaurs cannot take Mage or Rogue.");
          }}
        >
          {BASE_CLASSES.map((c) => {
            const banned = !classAllowed(race, c);
            return (
              <option key={c} value={c} disabled={banned}>
                {banned ? `${c} — not for Minotaurs` : c}
              </option>
            );
          })}
        </select>
      </label>
      {(locked || block) && <p className="path-block">Minotaurs cannot take Mage or Rogue.</p>}
      <button id="joinBtn" type="submit" disabled={locked}>
        Enter the Hamlet
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
          <p id="travelHint">The gate can carry you to another city.</p>
          <div id="travelButtons" />
          <button id="travelClose" type="button">
            Stay
          </button>
        </div>
      </div>
      <div id="skills">
        <button type="button" data-skill="attack">
          Attack
        </button>
        <button type="button" data-skill="heal">
          Heal
        </button>
        <button type="button" data-skill="fireball">
          Fireball
        </button>
        <button type="button" data-skill="stab">
          Stab
        </button>
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
              Set level
            </button>
          </div>
          <button id="sheetClose" type="button">
            Close
          </button>
        </div>
      </div>
      <div id="death" hidden>
        <div id="deathPanel">
          <h2>You have fallen</h2>
          <p id="deathHint">Respawn in Uthgaard leaves some gold and XP behind.</p>
          <button id="respawnBtn" type="button">
            Respawn in Uthgaard
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
