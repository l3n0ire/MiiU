// Browser-only MiiU entry (issue #19): runs the whole island in this tab.
// Loaded as bundle.js before public/app.js; it installs window.MIIU_CONNECT, which
// app.js uses instead of opening a WebSocket. The visitor's model settings and island
// save stay on this device; an OpenAI key, if used, is sent only to OpenAI.
import { createLLM, type LLMConfig } from "../server/llm.ts";
import { Sim } from "../server/sim.ts";
import {
  LANDMARKS, MAP_H, MAP_W, migrateWorld, newCharacter, seedWorld,
  type World, type WorldStore,
} from "../server/world.ts";

const SETUP_KEY = "miiu.setup.v1";
const WORLD_KEY = "miiu.world.v1";
const KEY_KEY = "miiu.openai-key"; // only present when the visitor opted into remembering

interface SavedSetup {
  provider: "ollama" | "openai";
  ollamaUrl?: string;
  model?: string;
  openaiReasoning?: string;
  rememberKey?: boolean;
}

declare global {
  interface Window { MIIU_CONNECT?: () => unknown; MIIU_STATIC?: boolean }
}
// Synchronous marker: tells app.js (loads right after this bundle) to wait for
// window.MIIU_CONNECT instead of opening a WebSocket. Set before boot so the
// marker exists even while the setup overlay is still up.
window.MIIU_STATIC = true;

const localStore: WorldStore = {
  save(world: World) {
    try {
      localStorage.setItem(WORLD_KEY, JSON.stringify(world));
    } catch (err) {
      console.error("Could not save island to localStorage:", err);
    }
  },
};

function loadSavedWorld(): World {
  try {
    const raw = localStorage.getItem(WORLD_KEY);
    if (raw) return migrateWorld(JSON.parse(raw) as World);
  } catch (err) {
    console.error("Saved island unreadable, starting fresh:", err);
  }
  const w = seedWorld();
  localStore.save(w);
  return w;
}

// ---- fake WebSocket: same message contract as server/index.ts, backed by an in-page Sim ----
class LocalSocket {
  readyState = 1; // OPEN
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private sim?: Sim;

  constructor(private setup: SavedSetup, private apiKey: string | null) {
    queueMicrotask(() => this.start());
  }

  private start() {
    const config: LLMConfig = {
      provider: this.setup.provider,
      ollamaUrl: this.setup.ollamaUrl || undefined,
      openaiApiKey: this.apiKey ?? undefined,
      model: this.setup.model || undefined,
      openaiReasoning: this.setup.openaiReasoning || undefined,
    };
    const llm = createLLM(config);
    this.sim = new Sim(loadSavedWorld(), (event) => this.deliver({ type: "event", event }), { llm, store: localStore });
    this.deliver({ type: "init", map: { w: MAP_W, h: MAP_H, landmarks: LANDMARKS }, events: this.sim.world.events, model: llm.model });
    setInterval(() => this.sim && this.deliver({ type: "state", ...this.sim.snapshot() }), 200);
  }

  private deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  send(raw: string) {
    if (!this.sim) return; // sim not started yet; setup overlay covers the UI until it is
    const sim = this.sim;
    const msg = JSON.parse(String(raw));
    switch (msg.type) {
      case "create": {
        const name = String(msg.name ?? "").trim().slice(0, 20);
        if (!name) return;
        sim.addCharacter(newCharacter({
          name,
          personality: String(msg.personality ?? "").slice(0, 300),
          likes: String(msg.likes ?? "").slice(0, 100),
          dislikes: String(msg.dislikes ?? "").slice(0, 100),
          color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : "#888888",
        }));
        break;
      }
      case "delete": sim.removeCharacter(msg.id); break;
      case "pause": sim.paused = !sim.paused; break;
      case "speed": sim.speed = Math.max(0.25, Math.min(4, Number(msg.value) || 1)); break;
      case "talk": sim.forceTalk(msg.a, msg.b); break;
      case "chatStart": {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String).slice(0, 4) : [];
        if (ids.length) sim.startUserChat(ids);
        break;
      }
      case "chatSend": sim.userChatMessage(String(msg.text ?? "")); break;
      case "chatEnd": sim.endUserChat(); break;
      case "event": {
        const text = String(msg.text ?? "").trim().slice(0, 200);
        if (text) sim.triggerEvent(text, msg.target || null, msg.gather || null);
        break;
      }
    }
  }

  close() { /* nothing to close: the sim stops with the tab */ }
}

// ---- setup overlay ----
function el(tag: string, attrs: Record<string, string> = {}, html = ""): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

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

// Ephemeral key for this tab when the visitor did not opt into remembering.
let sessionKey: string | null = null;

function readyToStart(s: SavedSetup | null): boolean {
  if (!s) return false;
  if (s.provider === "openai") return Boolean(sessionKey ?? storedKey());
  return true;
}

function showSetup(onStart: () => void) {
  const existing = savedSetup();
  const overlay = el("div", { id: "miiuSetup" });
  overlay.setAttribute("style", [
    "position:fixed", "inset:0", "background:rgba(45,42,38,.45)", "z-index:1000",
    "display:flex", "align-items:center", "justify-content:center", "padding:16px",
  ].join(";"));
  const card = el("div", {}, "");
  card.setAttribute("style", [
    "background:#fffaf2", "color:#2d2a26", "border-radius:14px", "padding:20px",
    "max-width:440px", "width:100%", "font:14px/1.45 ui-rounded,'SF Pro Rounded',system-ui,sans-serif",
    "max-height:90vh", "overflow-y:auto",
  ].join(";"));
  card.innerHTML = `
    <h2 style="margin:0 0 4px;font-size:18px">Your island, your model</h2>
    <p style="margin:0 0 14px;color:#8a8278">This island lives in this browser only - it pauses when you close the tab,
    and its save stays on this device. Conversations are written by a model <b>you</b> connect.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button type="button" id="miiuProvOpenAI" style="flex:1">OpenAI key</button>
      <button type="button" id="miiuProvOllama" style="flex:1">My own Ollama</button>
    </div>
    <div id="miiuPaneOpenAI">
      <label style="font-size:13px;color:#8a8278">OpenAI API key</label>
      <input id="miiuKey" type="password" autocomplete="off" placeholder="sk-..." style="width:100%;margin:4px 0" />
      <label style="font-size:13px;display:flex;gap:6px;align-items:center;margin-bottom:8px">
        <input id="miiuRemember" type="checkbox" style="width:auto;margin:0" /> Remember the key on this device
      </label>
      <p style="font-size:12px;color:#8a8278;margin:0 0 10px">Without the checkbox the key is kept only while this tab is open.
      Either way it is sent only to api.openai.com when your island talks - this site serves static files and never receives it.
      Anyone using this browser profile can use what you store here, so prefer not remembering on shared devices.</p>
      <label style="font-size:13px;color:#8a8278">Model (optional)</label>
      <input id="miiuModel" type="text" autocomplete="off" placeholder="default: gpt-5-mini" style="width:100%;margin:4px 0" />
    </div>
    <div id="miiuPaneOllama" style="display:none">
      <label style="font-size:13px;color:#8a8278">Ollama URL</label>
      <input id="miiuOllamaUrl" type="text" autocomplete="off" value="http://localhost:11434" style="width:100%;margin:4px 0" />
      <label style="font-size:13px;color:#8a8278">Model (optional)</label>
      <input id="miiuOllamaModel" type="text" autocomplete="off" placeholder="default: gemma4-pi" style="width:100%;margin:4px 0" />
      <p style="font-size:12px;color:#8a8278;margin:0 0 10px">Your browser talks straight to your Ollama; nothing is sent anywhere else.
      Two one-time steps on your machine: start Ollama with <code>OLLAMA_ORIGINS=${location.origin} ollama serve</code>
      so it accepts this site's requests, and allow the browser's "local network access" permission if it asks. Ollama must run on this computer (localhost/127.0.0.1) - a server on another machine isn't reachable from this page.
      Fully offline alternative: run the repo locally (<code>npm start</code>).</p>
      <button type="button" id="miiuTestOllama">Test connection</button>
      <span id="miiuOllamaStatus" style="font-size:12px;margin-left:8px"></span>
    </div>
    <div id="miiuSetupError" style="color:#b3261e;font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button type="button" id="miiuStart" style="flex:1;background:#ff7a59;border:none;color:#fff;padding:8px;border-radius:8px">Start my island</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;font-size:13px">
      <button type="button" id="miiuExport">Export island</button>
      <button type="button" id="miiuImport">Import island</button>
      <button type="button" id="miiuReset" style="color:#b3261e">Reset island</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const $ = (id: string) => card.querySelector(id) as HTMLElement & { value?: string; checked?: boolean };
  let provider: "ollama" | "openai" = existing?.provider ?? "openai";
  const paint = () => {
    $("#miiuPaneOpenAI").style.display = provider === "openai" ? "" : "none";
    $("#miiuPaneOllama").style.display = provider === "ollama" ? "" : "none";
    ($("#miiuProvOpenAI") as HTMLElement).style.fontWeight = provider === "openai" ? "700" : "400";
    ($("#miiuProvOllama") as HTMLElement).style.fontWeight = provider === "ollama" ? "700" : "400";
  };
  $("#miiuProvOpenAI").onclick = () => { provider = "openai"; paint(); };
  $("#miiuProvOllama").onclick = () => { provider = "ollama"; paint(); };
  if (existing?.model) $("#miiuModel").value = existing.model;
  if (existing?.ollamaUrl) $("#miiuOllamaUrl").value = existing.ollamaUrl;
  if (existing?.openaiReasoning) { /* kept in setup record; no UI field yet */ }
  const hasKey = Boolean(storedKey());
  if (hasKey) $("#miiuKey").value = "••••••••••••"; // hint a key is remembered; never echo it
  $("#miiuRemember").checked = Boolean(existing?.rememberKey && hasKey); // reflect current state; unchecking + Start forgets
  paint();

  $("#miiuTestOllama").onclick = async () => {
    const status = $("#miiuOllamaStatus");
    status.textContent = "checking…";
    try {
      const base = ($("#miiuOllamaUrl").value ?? "http://localhost:11434").replace(/\/$/, "");
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: { name: string }[] };
      status.textContent = `connected - ${body.models?.length ?? 0} model(s) installed`;
    } catch {
      status.textContent = "cannot reach Ollama - check it is running and OLLAMA_ORIGINS includes this site (see note above)";
    }
  };

  $("#miiuStart").onclick = () => {
    const err = $("#miiuSetupError");
    let setup: SavedSetup;
    if (provider === "openai") {
      const typed = ($("#miiuKey").value ?? "").trim();
      const key = typed && !typed.startsWith("•") ? typed : storedKey();
      if (!key) { err.textContent = "Paste your OpenAI API key first."; return; }
      sessionKey = key;
      const remember = Boolean($("#miiuRemember").checked);
      if (remember) localStorage.setItem(KEY_KEY, key); else localStorage.removeItem(KEY_KEY);
      setup = { provider, model: $("#miiuModel").value?.trim() || undefined, rememberKey: remember };
    } else {
      setup = {
        provider,
        ollamaUrl: ($("#miiuOllamaUrl").value ?? "").trim() || "http://localhost:11434",
        model: $("#miiuOllamaModel").value?.trim() || undefined,
      };
    }
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
    overlay.remove();
    onStart();
  };

  $("#miiuExport").onclick = () => {
    const raw = localStorage.getItem(WORLD_KEY);
    if (!raw) { $("#miiuSetupError").textContent = "No island to export yet."; return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    a.download = "miiu-island.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("#miiuImport").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      try {
        const text = await input.files?.[0]?.text();
        if (!text) return;
        const world = migrateWorld(JSON.parse(text) as World); // validate + sanitize before saving
        localStorage.setItem(WORLD_KEY, JSON.stringify(world));
        location.reload();
      } catch {
        $("#miiuSetupError").textContent = "That file is not a valid MiiU island export.";
      }
    };
    input.click();
  };
  $("#miiuReset").onclick = () => {
    if (confirm("Erase everything saved on this device - the island, your model settings, and any remembered key?")) {
      localStorage.removeItem(WORLD_KEY);
      localStorage.removeItem(SETUP_KEY);
      localStorage.removeItem(KEY_KEY);
      location.reload();
    }
  };
}

// ---- boot ----
function boot() {
  // Gear button reopens setup (change model, export/import, reset).
  const gear = el("button", { id: "miiuGear", type: "button" }, "⚙ Model &amp; save");
  gear.addEventListener("click", () => showSetup(() => location.reload()));
  document.querySelector("header")?.appendChild(gear);

  const start = () => {
    const setup = savedSetup()!;
    const key = sessionKey ?? storedKey();
    window.MIIU_CONNECT = () => new LocalSocket(setup, key);
    // app.js calls connect() at the end of its own script load; it runs after this bundle.
  };

  if (readyToStart(savedSetup())) start();
  else showSetup(start);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
