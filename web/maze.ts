// The Stone Maze page: renders the cooperative contraption puzzle from
// maze-engine.ts on a canvas. The "What happened" feed is shown by default -
// door openings, plate hand-offs, discoveries and shares are the point of
// this puzzle. Bubbles over miis are short template lines from the engine.
//
// Crew control: by default the engine's built-in coordinator assigns two
// plate-holders and sends the others fetching - code-driven cooperation that
// completes the puzzle but never scouts and never shares, so it never finds
// the hidden cache (the UI says so). The visitor can connect their own model
// (their OpenAI key or their own Ollama - same setup storage and key handling
// as the other pages, never sent anywhere except the chosen provider) and
// then EVERY mii decides for itself through maze-minds.ts: fetch, hold a
// plate, release, scout, share a discovery it personally made - or keep it to
// itself. The panel always names each character's actual driver. If the
// aggregate call budget runs out, the run FAILS (the agents failed to
// accomplish the task) and the page offers a restart with a different limit -
// there is no silent built-in completion.
import { Maze, MAZE_W, MAZE_H, type CrewMember, type CellEdge } from "./maze-engine.ts";
import { MazeMinds } from "./maze-minds.ts";
import { createJsonCaller } from "../server/llm-json.ts";
import { migrateWorld, seedWorld } from "../server/world.ts";

const TILE = 40;
const canvas = document.getElementById("puzzleMap") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
canvas.width = MAZE_W * TILE;
canvas.height = MAZE_H * TILE;
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);

function loadCrew(): CrewMember[] {
  let chars: { id: string; name: string; color: string }[] = [];
  try {
    const raw = localStorage.getItem("miiu.world.v1");
    if (raw) chars = migrateWorld(JSON.parse(raw)).characters;
  } catch { /* unreadable save: fall through to seeds */ }
  const seeds = seedWorld().characters;
  const crew = chars.slice(0, 4);
  for (let i = 0; crew.length < 4 && i < seeds.length; i++) {
    if (!crew.some((c) => c.name === seeds[i].name)) crew.push(seeds[i]);
  }
  return crew.slice(0, 4).map((c) => ({ id: c.id, name: c.name, color: c.color }));
}

let seed = 7;
let puzzle = new Maze(loadCrew(), seed);
let showChatter = true; // the feed is the point of this puzzle
let confetti: { x: number; y: number; vx: number; vy: number; color: string; t: number }[] = [];
let celebrated = false;
let failedShown = false;
interface RunRecord { sharing: boolean; calls: number | null; elapsed: number; seed: number; found: string | null; shared: string | null; cache: string | null }
let lastRun: RunRecord | null = null; // the previous completed run on this page (for same-layout comparison)

// ---- crew control (optional visitor-connected model) ----
const SETUP_KEY = "miiu.setup.v1"; // shared with the other pages
const KEY_KEY = "miiu.openai-key"; // only present when the visitor opted into remembering
const MAZE_KEY = "miiu.stone-maze.v1"; // this page's own puzzle options

interface SavedSetup {
  provider: "ollama" | "openai";
  ollamaUrl?: string;
  model?: string;
  rememberKey?: boolean;
}
interface MazeOptions { sharing: boolean; maxCalls: number }

let minds: MazeMinds | null = null;
let sessionKey: string | null = null;
let mazeOptions: MazeOptions = loadMazeOptions();

function loadMazeOptions(): MazeOptions {
  try {
    const raw = localStorage.getItem(MAZE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<MazeOptions>;
      return { sharing: o.sharing !== false, maxCalls: Math.max(10, Math.min(200, o.maxCalls ?? 60)) };
    }
  } catch { /* fall through */ }
  return { sharing: true, maxCalls: 60 };
}
function saveMazeOptions() { localStorage.setItem(MAZE_KEY, JSON.stringify(mazeOptions)); }

function savedSetup(): SavedSetup | null {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    return raw ? (JSON.parse(raw) as SavedSetup) : null;
  } catch {
    return null;
  }
}

function storedKey(): string | null {
  return localStorage.getItem(KEY_KEY);
}

function attachMinds(setup: SavedSetup, key: string | null) {
  try {
    const caller = createJsonCaller({
      provider: setup.provider,
      ollamaUrl: setup.ollamaUrl || undefined,
      openaiApiKey: key ?? undefined,
      model: setup.model || undefined,
    });
    minds = new MazeMinds(caller, { maxCalls: mazeOptions.maxCalls });
    puzzle.setController(minds);
  } catch (err) {
    console.error("Could not connect model:", err);
    minds = null;
    puzzle.setController(null);
  }
}

function connectFromStorage() {
  const setup = savedSetup();
  if (!setup) return;
  const key = sessionKey ?? storedKey();
  if (setup.provider === "openai" && !key) return;
  attachMinds(setup, key);
}

function renderCrewPanel() {
  const driver = $("crewDriver");
  const last = $("crewLast");
  const btn = $("crewSetupBtn") as HTMLButtonElement;
  if (!minds) {
    driver.textContent = "Built-in logic (no model connected) - two miis hold the plates, the rest fetch; never scouts or shares";
    last.style.display = "none";
    btn.textContent = "Connect a model";
    return;
  }
  btn.textContent = "Change model";
  const stats = minds.stats();
  const statuses = minds.statuses();
  const fallen = statuses.filter((s) => s.state === "fallback").length;
  driver.textContent = statuses.length > 0 && fallen === statuses.length
    ? "Built-in logic - model unavailable for every mii"
    : `Each mii decides for itself with ${minds.modelLabel}`;
  driver.textContent += mazeOptions.sharing ? " - sharing ON" : " - sharing OFF";
  const mockDriver = /mock/i.test(minds.modelLabel);
  const lines = statuses.map((s) => {
    const tag = s.state === "fallback" ? "[built-in]" : s.state === "thinking" ? "[thinking]" : mockDriver ? "[mock]" : "[model]";
    return `${tag} ${s.name}: ${s.detail}`;
  });
  if (stats.calls > 0) lines.push(`${stats.calls}/${stats.maxCalls} model calls (one choice each), ${stats.decisionsApplied} move${stats.decisionsApplied === 1 ? "" : "s"} started this puzzle`);
  last.textContent = lines.join("\n");
  last.style.whiteSpace = "pre-line";
  last.style.display = lines.length ? "" : "none";
}

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function showCrewSetup() {
  const existing = savedSetup();
  const overlay = el("div", { id: "crewSetupOverlay" });
  overlay.setAttribute("style", [
    "position:fixed", "inset:0", "background:rgba(45,42,38,.45)", "z-index:1000",
    "display:flex", "align-items:center", "justify-content:center", "padding:16px",
  ].join(";"));
  const card = el("div");
  card.setAttribute("style", [
    "background:#fffaf2", "color:#2d2a26", "border-radius:14px", "padding:20px",
    "max-width:440px", "width:100%", "font:14px/1.45 ui-rounded,'SF Pro Rounded',system-ui,sans-serif",
    "max-height:90vh", "overflow-y:auto",
  ].join(";"));
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <h2 style="margin:0 0 4px;font-size:18px">Your crew, your model</h2>
      <button type="button" id="crewClose" aria-label="Close setup" style="background:none;border:none;font-size:18px;cursor:pointer;color:#8a8278;padding:0 0 0 12px;line-height:1">✕</button>
    </div>
    <p style="margin:0 0 14px;color:#8a8278">A model <b>you</b> connect gives each mii its own decisions:
    fetch a crate, hold a pressure plate (the stone door only opens while BOTH plates are held), release,
    scout the walls for a hidden crack - and if it finds one, <b>share it with the crew or keep it to
    itself</b>. What a mii knows is its own until it shares. They still walk and carry with the same rules.
    If a mii's model times out or errors, that mii alone switches to built-in logic, named per character.
    If the call budget runs out, the run <b>fails</b> and you can restart with a different limit.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button type="button" id="crewProvOpenAI" style="flex:1">OpenAI key</button>
      <button type="button" id="crewProvOllama" style="flex:1">My own Ollama</button>
    </div>
    <div id="crewPaneOpenAI">
      <label style="font-size:13px;color:#8a8278">OpenAI API key</label>
      <input id="crewKey" type="password" autocomplete="off" placeholder="sk-..." style="width:100%;margin:4px 0" />
      <label style="font-size:13px;display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <input id="crewRemember" type="checkbox" style="width:auto;margin:0" /> Remember the key on this device
      </label>
      <p style="font-size:12px;color:#8a8278;margin:0 0 10px">Without the checkbox the key is kept only while this tab is open.
      Either way it is sent only to api.openai.com when the crew needs a decision - this site serves static files and never receives it.
      Anyone using this browser profile can use what you store here, so prefer not remembering on shared devices.</p>
      <label style="font-size:13px;color:#8a8278">Model (optional)</label>
      <input id="crewModel" type="text" autocomplete="off" placeholder="default: gpt-6-luna" style="width:100%;margin:4px 0" />
    </div>
    <div id="crewPaneOllama" style="display:none">
      <label style="font-size:13px;color:#8a8278">Ollama URL</label>
      <input id="crewOllamaUrl" type="text" autocomplete="off" value="http://localhost:11434" style="width:100%;margin:4px 0" />
      <label style="font-size:13px;color:#8a8278">Model (optional)</label>
      <input id="crewOllamaModel" type="text" autocomplete="off" placeholder="default: gemma4-pi" style="width:100%;margin:4px 0" />
      <ol style="font-size:12px;color:#8a8278;margin:0 0 10px;padding-left:18px">
        <li>Start Ollama on this computer: <code>OLLAMA_ORIGINS=${location.origin} ollama serve</code></li>
        <li>Allow "local network access" if the browser asks.</li>
        <li>Keep Ollama running here - this page can only reach Ollama on this computer.</li>
      </ol>
      <button type="button" id="crewTestOllama">Test connection</button>
      <span id="crewOllamaStatus" style="font-size:12px;margin-left:8px"></span>
    </div>
    <hr style="border:none;border-top:1px solid #e4dccd;margin:12px 0" />
    <label style="font-size:13px;display:flex;gap:6px;align-items:center;margin-bottom:8px">
      <input id="crewSharing" type="checkbox" style="width:auto;margin:0" /> Let miis share discoveries with the crew
    </label>
    <label style="font-size:13px;color:#8a8278">Call budget per puzzle (aggregate, all four miis)</label>
    <input id="crewBudget" type="number" min="10" max="200" step="5" style="width:90px;margin:4px 0" />
    <p style="font-size:12px;color:#8a8278;margin:0 0 10px">Each mii makes its own short calls when its situation
    changes. When the budget runs out the agents fail the task and you can restart with a different limit - the
    built-in logic does not silently finish it. These are call/token bounds, not a dollar cap.</p>
    <div id="crewSetupError" style="color:#b3261e;font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" id="crewStart" style="flex:1;background:#ff7a59;border:none;color:#fff;padding:8px;border-radius:8px">Connect</button>
      <button type="button" id="crewDisconnect" style="flex:1">Use built-in logic</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const $c = (id: string) => card.querySelector(id) as HTMLElement & { value?: string; checked?: boolean };
  let provider: "ollama" | "openai" = existing?.provider ?? "openai";
  const paint = () => {
    $c("#crewPaneOpenAI").style.display = provider === "openai" ? "" : "none";
    $c("#crewPaneOllama").style.display = provider === "ollama" ? "" : "none";
    $c("#crewProvOpenAI").style.fontWeight = provider === "openai" ? "700" : "400";
    $c("#crewProvOllama").style.fontWeight = provider === "ollama" ? "700" : "400";
  };
  $c("#crewProvOpenAI").onclick = () => { provider = "openai"; paint(); };
  $c("#crewProvOllama").onclick = () => { provider = "ollama"; paint(); };
  if (existing?.model) { $c("#crewModel").value = existing.model; $c("#crewOllamaModel").value = existing.model; }
  if (existing?.ollamaUrl) $c("#crewOllamaUrl").value = existing.ollamaUrl;
  const hasKey = Boolean(storedKey());
  if (hasKey) $c("#crewKey").value = "••••••••••••"; // hint a key is remembered; never echo it
  $c("#crewRemember").checked = Boolean(existing?.rememberKey && hasKey);
  $c("#crewSharing").checked = mazeOptions.sharing;
  $c("#crewBudget").value = String(mazeOptions.maxCalls);
  paint();

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  $c("#crewClose").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  $c("#crewTestOllama").onclick = async () => {
    const status = $c("#crewOllamaStatus");
    status.textContent = "checking…";
    try {
      const base = ($c("#crewOllamaUrl").value ?? "http://localhost:11434").replace(/\/$/, "");
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: { name?: string }[] };
      status.textContent = `connected - ${body.models?.length ?? 0} model(s) installed`;
    } catch {
      status.textContent = "cannot reach Ollama - check it is running and OLLAMA_ORIGINS includes this site (see note above)";
    }
  };

  const readOptions = () => {
    mazeOptions = {
      sharing: Boolean($c("#crewSharing").checked),
      maxCalls: Math.max(10, Math.min(200, Number($c("#crewBudget").value) || 60)),
    };
    saveMazeOptions();
  };

  $c("#crewStart").onclick = () => {
    const err = $c("#crewSetupError");
    let setup: SavedSetup;
    if (provider === "openai") {
      const typed = ($c("#crewKey").value ?? "").trim();
      const key = typed && !typed.startsWith("•") ? typed : storedKey();
      if (!key) { err.textContent = "Paste your OpenAI API key first."; return; }
      sessionKey = key;
      const remember = Boolean($c("#crewRemember").checked);
      if (remember) localStorage.setItem(KEY_KEY, key); else localStorage.removeItem(KEY_KEY);
      setup = { provider, model: $c("#crewModel").value?.trim() || undefined, rememberKey: remember };
    } else {
      setup = {
        provider,
        ollamaUrl: ($c("#crewOllamaUrl").value ?? "").trim() || "http://localhost:11434",
        model: $c("#crewOllamaModel").value?.trim() || undefined,
      };
    }
    readOptions();
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
    attachMinds(setup, sessionKey ?? storedKey());
    reset(false); // restart this layout under the new options
    close();
    renderCrewPanel();
  };

  $c("#crewDisconnect").onclick = () => {
    readOptions();
    minds = null;
    puzzle.setController(null);
    localStorage.removeItem(SETUP_KEY); // connecting again is a fresh choice
    reset(false);
    close();
    renderCrewPanel();
  };
}

function reset(newSeed: boolean, maxCalls?: number) {
  if (maxCalls !== undefined) { mazeOptions = { ...mazeOptions, maxCalls }; saveMazeOptions(); }
  if (newSeed) seed = Math.floor(Math.random() * 100000);
  puzzle = new Maze(loadCrew(), seed);
  puzzle.setSharing(mazeOptions.sharing);
  if (minds) { minds.newPuzzle(mazeOptions.maxCalls); puzzle.setController(minds); }
  confetti = [];
  celebrated = false;
  failedShown = false;
  $("winBanner").style.display = "none";
  $("failBanner").style.display = "none";
  ($("pauseBtn") as HTMLButtonElement).textContent = "Pause";
  renderLog();
}

function renderLog() {
  const log = $("puzzleLog");
  log.innerHTML = puzzle.log.slice(-40).map((l) =>
    `<div class="pline"><b>${esc(l.speaker)}</b> ${esc(l.text)}</div>`).join("") || '<p class="empty">Nothing yet.</p>';
  log.scrollTop = log.scrollHeight;
}

const drawn: { x0: number; y0: number; x1: number; y1: number }[] = [];
function fits(x0: number, y0: number, x1: number, y1: number): boolean {
  return drawn.every((r) => x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1);
}
function labelY(cx: number, base: number, w: number, h: number): number {
  let y = base;
  while (!fits(cx - w / 2, y - h, cx + w / 2, y) && y > 20) y -= h + 2;
  drawn.push({ x0: cx - w / 2, y0: y - h, x1: cx + w / 2, y1: y });
  return y;
}

function edgeKeyOf(e: CellEdge): string {
  return e.ax < e.bx || (e.ax === e.bx && e.ay <= e.by)
    ? `${e.ax},${e.ay}|${e.bx},${e.by}` : `${e.bx},${e.by}|${e.ax},${e.ay}`;
}

function draw() {
  drawn.length = 0;
  const s = puzzle.snapshot();
  const carved = new Set(s.carved);
  const carvedAt = (ax: number, ay: number, bx: number, by: number) =>
    carved.has(edgeKeyOf({ ax, ay, bx, by }));
  // stone floor
  ctx.fillStyle = "#b9b2a4";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.04)";
  for (let x = 0; x < MAZE_W; x++) for (let y = 0; y < MAZE_H; y++) if ((x + y) % 2 === 0) ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  // walls: between any two adjacent cells without a carved edge, plus the border
  ctx.fillStyle = "#6e675c";
  const WTH = 7; // wall thickness
  for (let x = 0; x < MAZE_W; x++) {
    for (let y = 0; y < MAZE_H; y++) {
      if (x + 1 < MAZE_W && !carvedAt(x, y, x + 1, y)) ctx.fillRect((x + 1) * TILE - WTH / 2, y * TILE, WTH, TILE);
      if (y + 1 < MAZE_H && !carvedAt(x, y, x, y + 1)) ctx.fillRect(x * TILE, (y + 1) * TILE - WTH / 2, TILE, WTH);
    }
  }
  ctx.strokeStyle = "#6e675c";
  ctx.lineWidth = WTH;
  ctx.strokeRect(0, 0, canvas.width, canvas.height);
  // the hidden crack: an ordinary wall until someone finds it
  if (s.crack && s.crack.foundByAnyone) {
    const vertical = s.crack.ay === s.crack.by;
    const wx = vertical ? (s.crack.ax + 1) * TILE : (s.crack.ax + 0.5) * TILE;
    const wy = vertical ? (s.crack.ay + 0.5) * TILE : (s.crack.ay + 1) * TILE;
    ctx.fillStyle = "#2d2a26";
    if (vertical) ctx.fillRect(wx - 6, wy - 14, 12, 28); else ctx.fillRect(wx - 14, wy - 6, 28, 12);
    ctx.strokeStyle = "#f2b134";
    ctx.lineWidth = 2;
    if (vertical) ctx.strokeRect(wx - 6, wy - 14, 12, 28); else ctx.strokeRect(wx - 14, wy - 6, 28, 12);
  }
  // the cache room glows once the crack is known
  if (s.chamber && s.crack?.foundByAnyone) {
    ctx.fillStyle = "rgba(242,177,52,0.18)";
    ctx.fillRect(s.chamber.x * TILE, s.chamber.y * TILE, TILE, TILE);
  }
  // the stone door across its edge
  {
    const d = s.door;
    const vertical = d.ay === d.by;
    const wx = vertical ? (d.ax + 1) * TILE : (d.ax + 0.5) * TILE;
    const wy = vertical ? (d.ay + 0.5) * TILE : (d.ay + 1) * TILE;
    if (d.open) {
      ctx.fillStyle = "#d9c8a0";
      if (vertical) ctx.fillRect(wx - 6, wy - TILE / 2, 12, TILE); else ctx.fillRect(wx - TILE / 2, wy - 6, TILE, 12);
      ctx.strokeStyle = "#8a5a30";
      ctx.lineWidth = 2;
      if (vertical) { ctx.beginPath(); ctx.moveTo(wx, wy - TILE / 2); ctx.lineTo(wx, wy + TILE / 2); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(wx - TILE / 2, wy); ctx.lineTo(wx + TILE / 2, wy); ctx.stroke(); }
    } else {
      ctx.fillStyle = "#4a443c";
      if (vertical) ctx.fillRect(wx - 5, wy - TILE / 2 + 2, 10, TILE - 4); else ctx.fillRect(wx - TILE / 2 + 2, wy - 5, TILE - 4, 10);
      ctx.fillStyle = "rgba(255,250,242,0.25)";
      if (vertical) ctx.fillRect(wx - 5, wy - 3, 10, 6); else ctx.fillRect(wx - 3, wy - 5, 6, 10);
    }
  }
  // pressure plates
  for (const p of s.plates) {
    const px = (p.x + 0.5) * TILE, py = (p.y + 0.5) * TILE;
    ctx.fillStyle = p.heldBy ? "#3fb57a" : "#c9c2b4";
    ctx.beginPath(); ctx.arc(px, py, p.heldBy ? 10 : 12, 0, 7); ctx.fill();
    ctx.strokeStyle = "#5a4a3a";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (p.heldBy) {
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    }
    ctx.fillStyle = "rgba(45,42,38,0.7)";
    ctx.font = "8px ui-rounded, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.heldBy ? "HELD" : "plate", px, py + 20);
  }
  // camp
  const cx = (s.camp.x + 0.5) * TILE, cy = (s.camp.y + 0.5) * TILE;
  ctx.fillStyle = "#c08552";
  ctx.beginPath(); ctx.moveTo(cx - 14, cy + 10); ctx.lineTo(cx, cy - 12); ctx.lineTo(cx + 14, cy + 10); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#8a5a30";
  ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#fffaf2";
  ctx.font = "bold 9px ui-rounded, system-ui, sans-serif";
  ctx.fillText("camp", cx, cy + 4);
  // crates (the golden cache crate shows once the crack is found)
  for (const c of s.crates) {
    if (c.delivered) continue;
    if (c.golden && !s.crack?.foundByAnyone) continue;
    const px = c.x * TILE, py = c.y * TILE;
    ctx.fillStyle = c.golden ? "#f2b134" : "#d99a5b";
    ctx.fillRect(px - 11, py - 9, 22, 18);
    ctx.strokeStyle = "#8a5a30";
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 11, py - 9, 22, 18);
    ctx.beginPath(); ctx.moveTo(px - 11, py); ctx.lineTo(px + 11, py); ctx.stroke();
    if (c.golden) {
      ctx.fillStyle = "#8a5a30";
      ctx.font = "bold 9px ui-rounded, system-ui, sans-serif";
      ctx.fillText("★", px, py + 3);
    }
  }
  // delivered crates stacked at camp
  s.crates.filter((c) => c.delivered).forEach((c, i) => {
    const px = cx - 26 + (i % 2) * 14, py = cy + 18 - Math.floor(i / 2) * 11;
    ctx.fillStyle = c.golden ? "#f2b134" : "#c08552";
    ctx.fillRect(px, py, 12, 10);
    ctx.strokeStyle = "#8a5a30";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px, py, 12, 10);
  });
  // members
  for (const m of s.members) {
    // faint dotted route so route changes are visible
    if (m.path.length > 1) {
      ctx.strokeStyle = m.color + "66";
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.x * TILE, m.y * TILE);
      for (const pt of m.path) ctx.lineTo(pt.x * TILE, pt.y * TILE);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const mx = m.x * TILE, my = m.y * TILE;
    const bounce = m.state === "celebrating" ? Math.abs(Math.sin(s.t * 6 + m.x)) * 6 : 0;
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(mx, my - 4 - bounce, 11, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (m.carrying) {
      ctx.fillStyle = "#d99a5b";
      ctx.fillRect(mx - 8, my - 26 - bounce, 16, 12);
      ctx.strokeStyle = "#8a5a30";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mx - 8, my - 26 - bounce, 16, 12);
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px ui-rounded, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(m.name.slice(0, 1).toUpperCase(), mx, my - 1 - bounce);
    ctx.fillStyle = "rgba(45,42,38,0.85)";
    ctx.font = "10px ui-rounded, system-ui, sans-serif";
    const nameW = ctx.measureText(m.name).width;
    const nameY = labelY(mx, my + 16 - bounce, nameW, 11);
    ctx.fillText(m.name, mx, nameY);
    const labels: Record<string, string> = {
      scouting: "scouting the walls", fetching: "fetching a crate",
      carrying: "carrying home", toPlate: "going to a plate",
      holding: "HOLDING a plate", celebrating: "",
    };
    const label = labels[m.state];
    if (label) {
      ctx.font = "italic 9px ui-rounded, system-ui, sans-serif";
      const lw = ctx.measureText(label).width;
      const ly = labelY(mx, nameY + 11, lw, 10);
      ctx.fillStyle = "rgba(45,42,38,0.6)";
      ctx.fillText(label, mx, ly);
    }
    if (showChatter && m.bubble) {
      ctx.font = "11px ui-rounded, system-ui, sans-serif";
      const w = ctx.measureText(m.bubble).width + 14;
      const bx = Math.min(Math.max(mx - w / 2, 4), canvas.width - w - 4);
      const by = labelY(mx, my - 46 - bounce, w, 18) - 8;
      ctx.fillStyle = "rgba(255,250,242,0.95)";
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      ctx.roundRect(bx, by - 14, w, 20, 8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#2d2a26";
      ctx.fillText(m.bubble, bx + w / 2, by);
    }
  }
  // confetti on completion
  if (s.status === "complete" && !celebrated) {
    celebrated = true;
    for (let i = 0; i < 80; i++) {
      confetti.push({
        x: cx + (Math.random() - 0.5) * 80, y: cy - 20,
        vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 120,
        color: ["#ff7a59", "#4a90d9", "#b36bd6", "#3fb57a", "#f2b134"][i % 5],
        t: 0,
      });
    }
    const found = s.stats.discoveries[0]?.name ?? null;
    const shared = s.stats.shares[0]?.name ?? null;
    $("winBanner").style.display = "";
    const knowledge = found
      ? shared
        ? `${found} found the hidden crack and shared it with the crew.${s.stats.routeUpdates.length ? ` ${s.stats.routeUpdates.length} route${s.stats.routeUpdates.length === 1 ? "" : "s"} automatically re-planned through it.` : " Everyone could slip through to the cache from then on."}`
        : `${found} found the hidden crack and kept it private - only ${found} could reach the cache.`
      : "Nobody found a hidden crack this run.";
    const cache = s.stats.cacheDeliveredBy ? ` ${s.stats.cacheDeliveredBy} brought home the golden cache crate!` : "";
    $("winStats").textContent = `Done in ${Math.round(s.elapsed)}s of island time - ${s.delivered}/${s.total} crates${minds ? `, ${minds.stats().calls} model calls` : ""} (sharing ${s.sharingAllowed ? "on" : "off"}). ${knowledge}${cache}`;
    // Same-layout comparison with the previous completed run on this page.
    // Descriptive, not a controlled experiment - model choices are stochastic.
    const prev = $("prevStats");
    if (lastRun && lastRun.seed === s.seed) {
      prev.textContent = `Previous run on this layout: ${Math.round(lastRun.elapsed)}s, ${lastRun.calls ?? "?"} calls, sharing ${lastRun.sharing ? "on" : "off"}${lastRun.shared ? `, crack shared by ${lastRun.shared}` : lastRun.found ? `, crack found by ${lastRun.found} (kept private)` : ", crack never found"}${lastRun.cache ? `, cache looted by ${lastRun.cache}` : ""}.`;
    } else {
      prev.textContent = "";
    }
    lastRun = { sharing: s.sharingAllowed, calls: minds ? minds.stats().calls : null, elapsed: s.elapsed, seed: s.seed, found, shared, cache: s.stats.cacheDeliveredBy };
  }
  // failure banner
  if (s.status === "failed" && !failedShown) {
    failedShown = true;
    $("failBanner").style.display = "";
    $("failText").textContent = `The model call budget (${minds?.stats().maxCalls ?? mazeOptions.maxCalls} calls) ran out with ${s.delivered}/${s.total} crates delivered. The crew's partial work is frozen as it was.`;
    ($("failBudget") as HTMLInputElement).value = String(Math.min(200, (minds?.stats().maxCalls ?? mazeOptions.maxCalls) + 20));
  }
  confetti = confetti.filter((c) => c.t < 2.5);
  for (const c of confetti) {
    c.t += 1 / 60; c.x += c.vx / 60; c.y += c.vy / 60; c.vy += 220 / 60;
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, 5, 5);
  }
  $("nowLine").textContent = nowLine(s);
  $("puzzleStatus").textContent = s.status === "failed"
    ? `Task failed - call budget used up - puzzle #${s.seed}`
    : s.paused
      ? `Paused - puzzle #${s.seed}`
      : s.status === "complete"
        ? `All supplies home! - puzzle #${s.seed}`
        : `Supplies: ${s.delivered}/${s.total} - door ${s.door.open ? "OPEN" : "shut"} - puzzle #${s.seed}${s.crack?.sharedBy ? ` - crack shared by ${s.crack.sharedBy}` : s.crack?.foundByAnyone ? " - crack found (private)" : ""}`;
  ($("pauseBtn") as HTMLButtonElement).textContent = s.paused ? "Resume" : "Pause";
}

function nowLine(s: ReturnType<Maze["snapshot"]>): string {
  if (s.status === "complete") return "All four crates are home.";
  if (s.status === "failed") return "The agents failed to accomplish the task - the call budget ran out.";
  const carrying = s.members.find((m) => m.state === "carrying");
  if (carrying) return `${carrying.name} is carrying a crate back to camp.`;
  const holders = s.members.filter((m) => m.state === "holding");
  if (holders.length === 2) return `${holders[0].name} and ${holders[1].name} are holding the plates - the door is open.`;
  if (holders.length === 1) return `${holders[0].name} is holding a plate - one more holder needed for the door.`;
  const scouting = s.members.find((m) => m.state === "scouting");
  if (scouting) return `${scouting.name} is scouting the walls for a hidden crack.`;
  const fetching = s.members.find((m) => m.state === "fetching");
  if (fetching) return `${fetching.name} is heading for a crate.`;
  return "";
}

let last = performance.now();
let logTimer = 0;
let crewTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  puzzle.tick(dt);
  draw();
  logTimer += dt;
  if (logTimer > 0.5) { logTimer = 0; renderLog(); }
  crewTimer += dt;
  if (crewTimer > 0.5) { crewTimer = 0; renderCrewPanel(); }
  requestAnimationFrame(frame);
}

$("pauseBtn").addEventListener("click", () => { puzzle.paused = !puzzle.paused; });
$("restartBtn").addEventListener("click", () => reset(false));
$("newBtn").addEventListener("click", () => reset(true));
($("speedRange") as HTMLInputElement).addEventListener("input", (e) => {
  puzzle.speed = Math.max(0.25, Math.min(4, Number((e.target as HTMLInputElement).value) || 1));
});
$("crewSetupBtn").addEventListener("click", () => showCrewSetup());
$("chatterBtn").addEventListener("click", () => {
  showChatter = !showChatter;
  $("chatterBtn").textContent = showChatter ? "Hide feed" : "Show feed";
  $("logPanel").style.display = showChatter ? "" : "none";
  if (showChatter) renderLog();
});
$("failRestartBtn").addEventListener("click", () => {
  const n = Math.max(10, Math.min(200, Number(($("failBudget") as HTMLInputElement).value) || mazeOptions.maxCalls));
  reset(false, n);
});

puzzle.setSharing(mazeOptions.sharing);
connectFromStorage();
renderCrewPanel();
requestAnimationFrame(frame);
