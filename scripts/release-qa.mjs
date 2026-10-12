import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8080/";
const TW = 48;
const TH = 24;
const fails = [];

function screenDelta(dx, dz) {
  return { sx: (dx - dz) * (TW / 2), sy: (dx + dz) * (TH / 2) };
}

function check(cond, msg) {
  if (!cond) {
    fails.push(msg);
    console.log("FAIL", msg);
  } else console.log("OK", msg);
}

async function boot(page, name, race) {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#joinBtn");
    return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
  });
  await page.fill("#username", name);
  if (race) await page.selectOption("#race", { label: race });
  await page.click("#joinBtn");
  await page.waitForFunction(() => window.__controlsTest?.getPos, { timeout: 20000 });
  await page.waitForTimeout(600);
}

async function closePanels(page) {
  await page.evaluate(() => {
    for (const id of ["shop", "train", "travel", "mapOverlay", "sheet", "bag", "death"]) {
      const el = document.querySelector("#" + id);
      if (el) el.hidden = true;
    }
  });
}

async function clickQuadrants(page, label) {
  const dirs = [
    ["right", 200, 0],
    ["left", -200, 0],
    ["up", 0, -120],
    ["down-right", 160, 130],
  ];
  for (const [name, dx, dy] of dirs) {
    await closePanels(page);
    const p0 = await page.evaluate(() => window.__controlsTest.getPos());
    const box = await page.locator("#view").boundingBox();
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await page.waitForTimeout(800);
    const p1 = await page.evaluate(() => window.__controlsTest.getPos());
    const moved = screenDelta(p1.x - p0.x, p1.z - p0.z);
    const dot = moved.sx * dx + moved.sy * dy;
    const mag = Math.hypot(moved.sx, moved.sy) * Math.hypot(dx, dy) || 1;
    const toward = Math.hypot(moved.sx, moved.sy) < 8 ? 0 : dot / mag;
    const zone = await page.locator(".zone-line").innerText();
    console.log(label, name, "toward", toward.toFixed(2), "pos", p1.x.toFixed(1), p1.z.toFixed(1), zone);
    check(toward > 0.45, `${label} ${name} walked toward the click (${toward.toFixed(2)})`);
    check(!/Hornvale/.test(zone), `${label} ${name} stayed out of Hornvale (${zone})`);
  }
}

const browser = await chromium.launch({ headless: true });

{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const races = await (async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const el = document.querySelector("#race");
    return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
  });
    return page.locator("#race option").allTextContents();
  })();
  check(races.join("|") === "Human|Elf|Minotaur|Marshwarden", `races ${races.join("|")}`);
  await page.selectOption("#baseClass", "Mage");
  await page.selectOption("#race", { label: "Marshwarden" });
  await page.waitForSelector(".path-block");
  const block = await page.locator(".path-block").innerText();
  check(block.includes("Marshwardens cannot take Mage."), `mage block: ${block}`);
  await page.selectOption("#baseClass", "Fighter");
  await page.fill("#username", "Fen" + Math.floor(Math.random() * 1e5));
  await page.click("#joinBtn");
  await page.waitForFunction(() => window.__controlsTest?.npcs);
  await page.waitForTimeout(700);
  const fen = await page.evaluate(() => {
    const pos = window.__controlsTest.getPos();
    const npcs = window.__controlsTest.npcs().filter((n) => n.city === "fenhollow");
    const zone = document.querySelector(".zone-line")?.textContent || "";
    return { pos, npcs, zone };
  });
  console.log("fenhollow", JSON.stringify(fen));
  check(Math.hypot(fen.pos.x - 48, fen.pos.z - 72) < 12, `marshwarden spawn ${fen.pos.x.toFixed(1)},${fen.pos.z.toFixed(1)}`);
  check(fen.zone.includes("Hearthfields"), `fen zone ${fen.zone}`);
  check(fen.npcs.some((n) => n.name === "Vess" && n.role === "vendor"), "Vess vendor");
  check(fen.npcs.some((n) => n.name === "Hask" && n.role === "trainer"), "Hask trainer");
  await page.evaluate(() => {
    const sheet = document.querySelector("#sheet");
    const debug = document.querySelector("#debugLevel");
    if (sheet) sheet.hidden = false;
    if (debug) debug.hidden = false;
  });
  await page.dispatchEvent("#debugKillBtn", "pointerup");
  await page.waitForTimeout(400);
  await page.click("#respawnBtn");
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => window.__controlsTest.getPos());
  const home = await page.locator("#respawnBtn").innerText().catch(() => "");
  check(Math.hypot(back.x - 48, back.z - 72) < 12, `respawn fenhollow ${back.x.toFixed(1)},${back.z.toFixed(1)} btn ${home}`);
  await page.evaluate(() => window.__controlsTest.setKeys([]));
  await page.keyboard.press("m");
  await page.waitForTimeout(300);
  const mapTitle = await page.locator("#mapTitle").innerText();
  const mapShot = await page.locator("#mapCanvas").screenshot();
  check(mapTitle.includes("Reach"), `map title ${mapTitle}`);
  await page.screenshot({ path: "/workspace/screenshots/fenhollow-release.png" });
  check(errors.length === 0, `fen errors ${errors.join(" | ")}`);
  void mapShot;
  await page.close();
}

for (const dpr of [1, 2]) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await boot(page, "Click" + dpr + Math.floor(Math.random() * 1e4), "Human");
  const start = await page.evaluate(() => window.__controlsTest.getPos());
  check(Math.hypot(start.x, start.z) < 12, `dpr ${dpr} human starts in Caldrenmoor ${start.x.toFixed(1)},${start.z.toFixed(1)}`);
  await clickQuadrants(page, `dpr${dpr}`);
  await closePanels(page);
  const hunt = await page.evaluate(() => {
    const me = window.__controlsTest.getPos();
    const mobs = window.__controlsTest.monsters();
    const spider = mobs.find((m) => m.type === "Spider");
    const snake = mobs.find((m) => m.type === "Snake");
    const way = window.__controlsTest.npcs().find((n) => n.city === "uthgaard" && n.role === "wayfarer");
    const eadric = window.__controlsTest.npcs().find((n) => n.name === "Eadric");
    return { me, spider, snake, way, eadric };
  });
  async function approach(kind, target) {
    if (!target) {
      check(false, `${kind} missing`);
      return;
    }
    await closePanels(page);
    const before = await page.evaluate(() => window.__controlsTest.getPos());
    const screen = await page.evaluate((t) => window.__controlsTest.project(t.x, t.z), target);
    const box = await page.locator("#view").boundingBox();
    const view = await page.evaluate(() => window.__controlsTest.viewSize());
    const x = box.x + (screen.x / view.viewW) * box.width;
    const y = box.y + (screen.y / view.viewH) * box.height;
    if (x < box.x + 8 || y < box.y + 8 || x > box.x + box.width - 8 || y > box.y + box.height - 8) {
      await page.evaluate((t) => window.__controlsTest.place(t.x - 6, t.z - 4), target);
      await page.waitForTimeout(400);
    }
    const screen2 = await page.evaluate((t) => window.__controlsTest.project(t.x, t.z), target);
    const view2 = await page.evaluate(() => window.__controlsTest.viewSize());
    const box2 = await page.locator("#view").boundingBox();
    await page.mouse.click(box2.x + (screen2.x / view2.viewW) * box2.width, box2.y + (screen2.y / view2.viewH) * box2.height);
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => window.__controlsTest.getPos());
    const d0 = Math.hypot(target.x - before.x, target.z - before.z);
    const d1 = Math.hypot(target.x - after.x, target.z - after.z);
    console.log(kind, "dist", d0.toFixed(1), "->", d1.toFixed(1), "at", after.x.toFixed(1), after.z.toFixed(1));
    check(d1 < d0 - 0.4 || d1 < 3.2, `${kind} approached (${d0.toFixed(1)} -> ${d1.toFixed(1)})`);
  }
  if (dpr === 2) {
    await approach("spider", hunt.spider);
    await approach("snake", hunt.snake);
    await approach("wayfarer", hunt.way);
    await approach("eadric", hunt.eadric);
    await page.evaluate(() => {
      const sheet = document.querySelector("#sheet");
      const debug = document.querySelector("#debugLevel");
      if (sheet) sheet.hidden = false;
      if (debug) debug.hidden = false;
    });
    await page.dispatchEvent("#debugKillBtn", "pointerup");
    await page.waitForSelector("#respawnBtn", { timeout: 4000 });
    await page.click("#respawnBtn");
    await page.waitForTimeout(600);
    const home = await page.evaluate(() => window.__controlsTest.getPos());
    check(Math.hypot(home.x, home.z) < 14, `respawn village ${home.x.toFixed(1)},${home.z.toFixed(1)}`);
    await clickQuadrants(page, "after-respawn");
  }
  check(errors.length === 0, `dpr ${dpr} errors ${errors.join(" | ")}`);
  await page.close();
}

{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
  const name = "Tide" + Math.floor(Math.random() * 1e5);
  await boot(page, name, "Human");
  await page.evaluate(() => {
    const w = window.__controlsTest.npcs().find((n) => n.city === "uthgaard" && n.role === "wayfarer");
    window.__controlsTest.place(w.x + 1.2, w.z + 1.2);
  });
  await page.waitForTimeout(300);
  await page.click("#talkBtn");
  await page.waitForTimeout(200);
  const list = await page.locator("#travelButtons").innerText();
  check(list.includes("Eldenreach"), "wayfarer Eldenreach");
  check(list.includes("Hornwatch"), "wayfarer Hornwatch");
  check(list.includes("Wardstone Ring"), "wayfarer Wardstone");
  check(list.includes("Fenhollow"), "wayfarer Fenhollow");
  await page.locator("#travelButtons button", { hasText: "Wardstone Ring" }).click();
  await page.waitForTimeout(400);
  const ward = await page.evaluate(() => window.__controlsTest.getPos());
  const wardZone = await page.locator(".zone-line").innerText();
  console.log("wardstone", ward.x.toFixed(1), ward.z.toFixed(1), wardZone);
  check(Math.hypot(ward.x - 228, ward.z + 196) < 10, `wardstone landing ${ward.x.toFixed(1)},${ward.z.toFixed(1)}`);
  check(!/deep|ocean/i.test(wardZone), `wardstone zone ${wardZone}`);
  await page.evaluate(() => {
    const w = window.__controlsTest.npcs().find((n) => n.city === "wardstone" && n.role === "wayfarer");
    window.__controlsTest.place(w.x + 1.1, w.z + 1.1);
  });
  await page.waitForTimeout(250);
  await page.click("#talkBtn");
  const tide = await page.locator("#travelButtons button", { hasText: "Stiltwick" }).innerText();
  check(tide.includes("Reach level 20 to use the Tide stones."), `tide block: ${tide}`);
  const disabled = await page.locator("#travelButtons button", { hasText: "Stiltwick" }).isDisabled();
  check(disabled, "stiltwick disabled below 20");
  await page.evaluate(() => {
    document.querySelector("#travel").hidden = true;
    const sheet = document.querySelector("#sheet");
    const debug = document.querySelector("#debugLevel");
    if (sheet) sheet.hidden = false;
    if (debug) debug.hidden = false;
    const input = document.querySelector("#debugLevelInput");
    if (input) input.value = "20";
  });
  await page.dispatchEvent("#debugLevelBtn", "pointerup");
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector("#sheet").hidden = true;
    const w = window.__controlsTest.npcs().find((n) => n.city === "wardstone" && n.role === "wayfarer");
    window.__controlsTest.place(w.x + 1.1, w.z + 1.1);
  });
  await page.waitForTimeout(250);
  await page.click("#talkBtn");
  const open = await page.locator("#travelButtons button", { hasText: "Stiltwick" }).isDisabled();
  check(!open, "stiltwick opens at 20");
  await page.locator("#travelButtons button", { hasText: "Stiltwick" }).click();
  await page.waitForTimeout(400);
  const stil = await page.evaluate(() => window.__controlsTest.getPos());
  console.log("stiltwick", stil.x.toFixed(1), stil.z.toFixed(1));
  check(Math.hypot(stil.x + 50, stil.z - 262) < 12, `stiltwick landing ${stil.x.toFixed(1)},${stil.z.toFixed(1)}`);
  const saved = await page.evaluate((username) => {
    const map = JSON.parse(localStorage.getItem("uthgaard-characters-v1") || "{}");
    return map[username] || null;
  }, name);
  check(!!saved?.attunedGates?.includes("stiltwick"), `attuned before refresh ${JSON.stringify(saved?.attunedGates)}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const el = document.querySelector("#joinBtn");
    return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
  });
  await page.fill("#username", name);
  await page.click("#joinBtn");
  await page.waitForFunction(() => window.__controlsTest?.getPos);
  await page.waitForTimeout(500);
  const again = await page.evaluate((username) => {
    const map = JSON.parse(localStorage.getItem("uthgaard-characters-v1") || "{}");
    return { pos: window.__controlsTest.getPos(), save: map[username] };
  }, name);
  console.log("refresh", again.pos.x.toFixed(1), again.pos.z.toFixed(1), again.save?.attunedGates);
  check(Math.hypot(again.pos.x + 50, again.pos.z - 262) < 14, "position survives refresh");
  check(!!again.save?.attunedGates?.includes("stiltwick"), "attunement survives refresh");
  await page.close();
}

await browser.close();
if (fails.length) {
  console.log("FAILED", fails.length);
  process.exit(1);
}
console.log("ALL PASSED");
