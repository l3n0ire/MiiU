// Bridge puzzle page: renders the cooperative bridge-building scene from
// puzzle-engine.ts on a canvas. Chatter (short template lines from the engine)
// is hidden by default - the scene is meant to read from actions alone.
// Icons are inline SVG/text so they render identically everywhere (no emoji
// font dependency).
//
// Crew control: by default the engine's built-in assigner picks jobs. The
// visitor can connect their own model (their OpenAI key or their own Ollama -
// same setup storage and key handling as the playground page, never sent
// anywhere except the chosen provider) and then EVERY mii decides for itself
// through puzzle-minds.ts: its own calls, its own memory, its own choice to
// claim work, ask for a lift partner, or answer someone else's ask. The panel
// always names each character's actual driver, including per-character
// fallback to built-in logic.
import { BridgePuzzle, PUZZLE_W, PUZZLE_H, type CrewMember } from "./puzzle-engine.ts";
import { MindfulCrew } from "./puzzle-minds.ts";
import { createJsonCaller } from "../server/llm-json.ts";
import { migrateWorld, seedWorld } from "../server/world.ts";
import { recordCompletion, renderHistory } from "./scoring-ui.ts";

const TILE = 40;
const canvas = document.getElementById("puzzleMap") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
canvas.width = PUZZLE_W * TILE;
canvas.height = PUZZLE_H * TILE;
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);

// Crew: the visitor's own island residents when a save exists, else the seeds.
// Reading the save only - the puzzle never writes to the island's data.
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
// The same four miis play every puzzle on this page load. loadCrew() gives
// random ids to seed characters, so calling it per reset would create a NEW
// cast each time (and duplicate minds in the crew panel) - cache it.
const CREW = loadCrew();
let puzzle = new BridgePuzzle(CREW, seed);
let showChatter = false;
let confetti: { x: number; y: number; vx: number; vy: number; color: string; t: number }[] = [];
let celebrated = false;

// ---- crew control (optional visitor-connected model) ----
const SETUP_KEY = "miiu.setup.v1"; // shared with the playground page
const KEY_KEY = "miiu.openai-key"; // only present when the visitor opted into remembering

interface SavedSetup {
  provider: "ollama" | "openai";
  ollamaUrl?: string;
  model?: string;
  rememberKey?: boolean;
  callBudget?: number; // per-puzzle aggregate model call budget (default 40)
}

let minds: MindfulCrew | null = null;
let sessionKey: string | null = null; // this tab only, when "remember" is unchecked

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
    minds = new MindfulCrew(caller, undefined, undefined, setup.callBudget);
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

function renderBoardPanel() {
  const now = $("boardNow");
  const feed = $("boardFeed");
  if (!minds) {
    now.textContent = "Connect a model to watch them coordinate - the built-in assigner does not deliberate.";
    feed.textContent = "";
    return;
  }
  const board = minds.boardView();
  const lines: string[] = [];
  for (const a of board.asks) {
    lines.push(`ASK: ${a.name} wants a partner for ${a.piece}${a.declinedBy.length ? ` - declined by ${a.declinedBy.join(", ")}` : ""}`);
  }
  for (const h of board.helps) lines.push(`LIFT: ${h.name} agreed to help with ${h.piece}`);
  for (const c of board.claims) lines.push(`GET: ${c.name} is fetching ${c.piece}`);
  now.textContent = lines.join("\n") || "(nothing announced right now)";
  const events = minds.feedView();
  feed.textContent = events.length ? `Recent:\n${events.map((e) => `- ${e.text}`).join("\n")}` : "";
}

function renderCrewPanel() {
  const driver = $("crewDriver");
  const last = $("crewLast");
  const btn = $("crewSetupBtn") as HTMLButtonElement;
  renderBoardPanel();
  if (!minds) {
    driver.textContent = "Built-in logic (no model connected)";
    last.style.display = "none";
    btn.textContent = "Connect a model";
    return;
  }
  btn.textContent = "Change model";
  const stats = minds.stats();
  const statuses = minds.statuses();
  const fallen = statuses.filter((s) => s.state === "fallback").length;
  driver.textContent = minds.exhausted
    ? `Run failed - model call budget used up (${stats.calls}/${stats.budget})`
    : statuses.length > 0 && fallen === statuses.length
      ? "Built-in logic - model unavailable for every mii"
      : `Each mii decides for itself with ${minds.modelLabel}`;
  const lines = statuses.map((s) => {
    const tag = s.state === "fallback" ? "[built-in]" : s.state === "thinking" ? "[thinking]" : "[model]";
    return `${tag} ${s.name}: ${s.detail}`;
  });
  if (stats.calls > 0) lines.push(`${stats.calls}/${stats.budget} model call${stats.calls === 1 ? "" : "s"} (one choice each), ${stats.decisionsApplied} job${stats.decisionsApplied === 1 ? "" : "s"} started this puzzle`);
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
    which piece to carry, when to ask for a partner on a heavy beam, and whether to answer someone
    else's ask. Nobody is assigned jobs from above. They still walk, lift and place with the same
    rules - and any mii whose model can't answer falls back to built-in logic, named per character.</p>
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
      Each mii makes its own short calls when its situation changes, within the call budget you set below. Anyone using this browser profile can use what you store here,
      so prefer not remembering on shared devices.</p>
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
    <label style="font-size:13px;color:#8a8278">Model call budget per puzzle (shared by the whole crew)</label>
    <input id="crewBudget" type="number" min="1" step="1" style="width:120px;margin:4px 0" />
    <p style="font-size:12px;color:#8a8278;margin:0 0 10px">When the crew's calls run out, the run stops and the agents report failure - nothing is silently taken over by built-in logic - and you can restart with a different budget. A mii whose own call times out or errors still falls back to built-in logic on its own, named per character.</p>
    <div id="crewSetupError" style="color:#b3261e;font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" id="crewStart" style="flex:1;background:#ff7a59;border:none;color:#fff;padding:8px;border-radius:8px">Connect</button>
      <button type="button" id="crewDisconnect" style="flex:1">Use built-in logic</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const $c = (id: string) => card.querySelector(id) as HTMLElement & { value?: string; checked?: boolean };
  const readBudgetInput = () => Math.max(1, Math.floor(Number($c("#crewBudget").value) || 40));
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
  $c("#crewBudget").value = String(existing?.callBudget ?? 40);
  const hasKey = Boolean(storedKey());
  if (hasKey) $c("#crewKey").value = "••••••••••••"; // hint a key is remembered; never echo it
  $c("#crewRemember").checked = Boolean(existing?.rememberKey && hasKey);
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
      const body = (await res.json()) as { models?: { name: string }[] };
      status.textContent = `connected - ${body.models?.length ?? 0} model(s) installed`;
    } catch {
      status.textContent = "cannot reach Ollama - check it is running and OLLAMA_ORIGINS includes this site (see note above)";
    }
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
      setup = { provider, model: $c("#crewModel").value?.trim() || undefined, rememberKey: remember, callBudget: readBudgetInput() };
    } else {
      setup = {
        provider,
        ollamaUrl: ($c("#crewOllamaUrl").value ?? "").trim() || "http://localhost:11434",
        model: $c("#crewOllamaModel").value?.trim() || undefined,
        callBudget: readBudgetInput(),
      };
    }
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
    attachMinds(setup, sessionKey ?? storedKey());
    close();
    renderCrewPanel();
  };

  $c("#crewDisconnect").onclick = () => {
    minds = null;
    puzzle.setController(null);
    localStorage.removeItem(SETUP_KEY); // connecting again is a fresh choice
    close();
    renderCrewPanel();
  };
}

// ---- budget exhaustion: the agents failed, offer a restart with a new budget ----
let failOverlay: HTMLElement | null = null;
let failHandled = false;

function persistBudget(n: number) {
  const setup = savedSetup();
  if (!setup) return;
  setup.callBudget = n;
  localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
}

function showBudgetFailure() {
  if (failOverlay || !minds) return;
  const stats = minds.stats();
  const overlay = el("div", { id: "budgetFailOverlay" });
  overlay.setAttribute("style", [
    "position:fixed", "inset:0", "background:rgba(45,42,38,.45)", "z-index:1000",
    "display:flex", "align-items:center", "justify-content:center", "padding:16px",
  ].join(";"));
  const card = el("div");
  card.setAttribute("style", [
    "background:#fffaf2", "color:#2d2a26", "border-radius:14px", "padding:20px",
    "max-width:440px", "width:100%", "font:14px/1.45 ui-rounded,'SF Pro Rounded',system-ui,sans-serif",
  ].join(";"));
  card.innerHTML = `
    <h2 style="margin:0 0 4px;font-size:18px">The agents failed to accomplish the task</h2>
    <p style="margin:0 0 12px;color:#8a8278">They used all <b>${stats.budget}</b> model calls for this puzzle before finishing.
    The run stopped where it was - built-in logic did not take over, and no character was quietly switched.</p>
    <label style="font-size:13px;color:#8a8278">Call budget for the retry</label>
    <input id="failBudget" type="number" min="1" step="1" value="${stats.budget}" style="width:120px;margin:4px 0;display:block" />
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" id="failRestart" style="flex:1;background:#ff7a59;border:none;color:#fff;padding:8px;border-radius:8px">Restart with this budget</button>
      <button type="button" id="failDismiss" style="flex:1">Dismiss</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  failOverlay = overlay;
  const $f = (id: string) => card.querySelector(id) as HTMLElement & { value?: string };
  const close = () => { overlay.remove(); failOverlay = null; };
  $f("#failDismiss").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  $f("#failRestart").onclick = () => {
    const n = Math.max(1, Math.floor(Number($f("#failBudget").value) || stats.budget));
    minds!.setMaxCalls(n);
    persistBudget(n);
    close();
    reset(false); // same puzzle, fresh budget
  };
}

function reset(newSeed: boolean) {
  if (newSeed) seed = Math.floor(Math.random() * 100000);
  puzzle = new BridgePuzzle(CREW, seed);
  if (minds) { minds.newPuzzle(); puzzle.setController(minds); }
  confetti = [];
  celebrated = false;
  failHandled = false;
  if (failOverlay) { failOverlay.remove(); failOverlay = null; }
  $("winBanner").style.display = "none";
  ($("pauseBtn") as HTMLButtonElement).textContent = "Pause";
  renderLog();
}

function renderLog() {
  const log = $("puzzleLog");
  log.innerHTML = puzzle.log.slice(-30).map((l) =>
    `<div class="pline"><b>${esc(l.speaker)}</b> ${esc(l.text)}</div>`).join("") || '<p class="empty">Nothing yet.</p>';
  log.scrollTop = log.scrollHeight;
}

// Action labels and bubbles are small; when members cluster (e.g. both ends of
// a beam) their labels would overlap. Track drawn rects per frame and nudge up.
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

function draw() {
  drawn.length = 0;
  const s = puzzle.snapshot();
  const riverX0 = s.riverX0, riverX1 = s.riverX1, flag = s.flag;
  // banks
  ctx.fillStyle = "#a8d8a0";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.03)";
  for (let x = 0; x < PUZZLE_W; x++) for (let y = 0; y < PUZZLE_H; y++) if ((x + y) % 2 === 0) ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  // river
  ctx.fillStyle = "#6db6e8";
  ctx.fillRect(riverX0 * TILE, 0, (riverX1 - riverX0 + 1) * TILE, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  for (let y = 0; y < PUZZLE_H; y++) {
    ctx.beginPath();
    for (let x = riverX0; x <= riverX1 + 1; x++) {
      const px = x * TILE, py = y * TILE + TILE / 2 + Math.sin(s.t * 2 + x + y) * 3;
      if (x === riverX0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // goal flag
  const fx = (flag.x + 0.5) * TILE, fy = (flag.y + 0.5) * TILE;
  ctx.strokeStyle = "#5a4a3a";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(fx, fy + 14); ctx.lineTo(fx, fy - 16); ctx.stroke();
  ctx.fillStyle = "#ff7a59";
  ctx.beginPath(); ctx.moveTo(fx, fy - 16); ctx.lineTo(fx + 16, fy - 10); ctx.lineTo(fx, fy - 4); ctx.closePath(); ctx.fill();
  // unfilled gap cells
  for (const cell of s.bridge) {
    if (cell.filled) continue;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(cell.x * TILE + 4, cell.y * TILE + 8, TILE - 8, TILE - 16);
    ctx.setLineDash([]);
  }
  // pieces
  for (const p of s.pieces) {
    const px = p.x * TILE, py = p.y * TILE;
    if (p.kind === "block") {
      ctx.fillStyle = p.state === "placed" ? "#c08552" : "#d99a5b";
      ctx.fillRect(px - 14, py - 10, 28, 20);
      ctx.strokeStyle = "#8a5a30";
      ctx.lineWidth = 2;
      ctx.strokeRect(px - 14, py - 10, 28, 20);
    } else {
      ctx.fillStyle = p.state === "placed" ? "#a5713f" : "#c08552";
      ctx.fillRect(px - 18, py - 6, 36, 12);
      ctx.strokeStyle = "#7a4a20";
      ctx.lineWidth = 2;
      ctx.strokeRect(px - 18, py - 6, 36, 12);
      ctx.fillStyle = "#7a4a20";
      ctx.beginPath(); ctx.arc(px - 10, py, 2.5, 0, 7); ctx.arc(px + 10, py, 2.5, 0, 7); ctx.fill();
    }
  }
  // members
  for (const m of s.members) {
    const mx = m.x * TILE, my = m.y * TILE;
    const bounce = m.state === "celebrating" ? Math.abs(Math.sin(s.t * 6 + m.x)) * 6 : 0;
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(mx, my - 4 - bounce, 11, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px ui-rounded, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(m.name.slice(0, 1).toUpperCase(), mx, my - 1 - bounce);
    ctx.fillStyle = "rgba(45,42,38,0.85)";
    ctx.font = "10px ui-rounded, system-ui, sans-serif";
    const nameW = ctx.measureText(m.name).width;
    const nameY = labelY(mx, my + 16 - bounce, nameW, 11);
    ctx.fillText(m.name, mx, nameY);
    // action label: what they're doing, always visible (except celebrating)
    const labels: Record<string, string> = {
      fetching: "fetching", waiting: "needs help!", helping: "going to help",
      carrying: m.carrying === "beam" ? "carrying together" : "carrying",
      placing: "placing", crossing: "crossing!",
    };
    const label = labels[m.state];
    if (label) {
      ctx.font = "italic 9px ui-rounded, system-ui, sans-serif";
      const lw = ctx.measureText(label).width;
      const ly = labelY(mx, nameY + 11, lw, 10);
      ctx.fillStyle = "rgba(45,42,38,0.6)";
      ctx.fillText(label, mx, ly);
    }
    // chatter bubble: only when the user opted in
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
        x: fx + (Math.random() - 0.5) * 80, y: fy - 20,
        vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 120,
        color: ["#ff7a59", "#4a90d9", "#b36bd6", "#3fb57a", "#f2b134"][i % 5],
        t: 0,
      });
    }
    $("winBanner").style.display = "";
    $("winStats").textContent = `Built in ${Math.round(s.elapsed)}s of island time - ${s.totalPieces} pieces placed, ${s.assists} team lift${s.assists === 1 ? "" : "s"}.`;
    const { line: scoreText } = recordCompletion(localStorage, { mode: "puzzle", seed: s.seed, minds, sharing: null, elapsed: s.elapsed, speed: puzzle.speed });
    $("scoreLine").textContent = scoreText;
    renderHistory(localStorage, "puzzle", $("historyList"));
  }
  confetti = confetti.filter((c) => c.t < 2.5);
  for (const c of confetti) {
    c.t += 1 / 60; c.x += c.vx / 60; c.y += c.vy / 60; c.vy += 220 / 60;
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, 5, 5);
  }
  // "Now" line: the current action in plain readable text, outside the
  // canvas, so it stays legible on small screens where in-canvas labels shrink.
  $("nowLine").textContent = nowLine(s);
  $("puzzleStatus").textContent = minds?.exhausted && s.status !== "complete"
    ? `Run failed - out of model calls - puzzle #${s.seed}`
    : s.paused
      ? `Paused - puzzle #${s.seed}`
    : s.status === "complete"
      ? `Bridge complete - everyone across! - puzzle #${s.seed}`
      : s.status === "crossing"
        ? `Bridge built - crew crossing - ${s.crossedCount}/${s.members.length} across - puzzle #${s.seed}`
        : `Building the bridge - ${s.placedCount}/${s.totalPieces} pieces placed - puzzle #${s.seed}`;
  ($("pauseBtn") as HTMLButtonElement).textContent = s.paused ? "Resume" : "Pause";
}

function nowLine(s: ReturnType<BridgePuzzle["snapshot"]>): string {
  if (s.status === "complete") return "Bridge built - the whole crew made it across.";
  if (s.status === "crossing") return `Bridge built - the crew is crossing (${s.crossedCount}/${s.members.length} across).`;
  const byId = new Map(s.members.map((m) => [m.id, m]));
  const placing = s.members.find((m) => m.state === "placing");
  if (placing) return `${placing.name} is placing a ${placing.carrying ?? "piece"} into the bridge.`;
  const lift = s.pieces.find((p) => p.state === "carried" && p.carriers.length >= 2);
  if (lift) {
    const names = lift.carriers.map((id) => byId.get(id)?.name ?? "?").join(" + ");
    return `${names} are carrying the ${lift.kind} together.`;
  }
  const crossing = s.members.find((m) => m.state === "crossing");
  if (crossing) return `${crossing.name} is crossing the new bridge toward the flag.`;
  const carrying = s.members.find((m) => m.state === "carrying" && m.carrying);
  if (carrying) return `${carrying.name} is carrying a ${carrying.carrying}.`;
  const helping = s.members.find((m) => m.state === "helping" || m.state === "waiting");
  if (helping) return `${helping.name} is getting in place to help lift.`;
  const fetching = s.members.find((m) => m.state === "fetching");
  if (fetching) return `${fetching.name} is heading for a piece.`;
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
  if (showChatter && logTimer > 0.5) { logTimer = 0; renderLog(); }
  crewTimer += dt;
  if (crewTimer > 0.5) {
    crewTimer = 0;
    renderCrewPanel();
    if (minds?.exhausted && puzzle.status !== "complete" && !failHandled) {
      failHandled = true;
      puzzle.paused = true; // stop the scene: the run has failed
      showBudgetFailure();
    }
  }
  requestAnimationFrame(frame);
}

$("pauseBtn").addEventListener("click", () => {
  // A failed run (budget used up) cannot be resumed into silent progress:
  // re-open the failure dialog instead - the way forward is a restart.
  if (!puzzle.paused || !(minds?.exhausted && puzzle.status !== "complete")) {
    puzzle.paused = !puzzle.paused;
    return;
  }
  showBudgetFailure();
});
$("restartBtn").addEventListener("click", () => reset(false));
$("newBtn").addEventListener("click", () => reset(true));
($("speedRange") as HTMLInputElement).addEventListener("input", (e) => {
  puzzle.speed = Math.max(0.25, Math.min(4, Number((e.target as HTMLInputElement).value) || 1));
});
$("crewSetupBtn").addEventListener("click", () => showCrewSetup());
$("chatterBtn").addEventListener("click", () => {
  showChatter = !showChatter;
  $("chatterBtn").textContent = showChatter ? "Hide chatter" : "Show chatter";
  $("logPanel").style.display = showChatter ? "" : "none";
  if (showChatter) renderLog();
});

connectFromStorage();
renderCrewPanel();
requestAnimationFrame(frame);

// Show this mode's saved run history on load.
renderHistory(localStorage, "puzzle", $("historyList"));
