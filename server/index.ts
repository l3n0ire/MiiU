import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createLLM } from "./llm.ts";
import { configFromEnv } from "./llm-env.ts";
import { Sim } from "./sim.ts";
import { loadWorld, nodeStore } from "./storage-node.ts";
import { LANDMARKS, MAP_H, MAP_W, newCharacter } from "./world.ts";

const llm = createLLM(configFromEnv());
const MODEL = llm.model;

// Server-mode tunables come from MIIU_* env vars; the browser build passes its own config.
const simConfig = {
  maxChats: process.env.MIIU_MAX_CHATS === undefined ? undefined : Number(process.env.MIIU_MAX_CHATS),
  autoEvents: process.env.MIIU_AUTO_EVENTS !== "off",
  autoEventMin: process.env.MIIU_AUTO_EVENT_MIN === undefined ? undefined : Number(process.env.MIIU_AUTO_EVENT_MIN),
  autoEventMax: process.env.MIIU_AUTO_EVENT_MAX === undefined ? undefined : Number(process.env.MIIU_AUTO_EVENT_MAX),
  autoEventCooldown: process.env.MIIU_AUTO_EVENT_COOLDOWN === undefined ? undefined : Number(process.env.MIIU_AUTO_EVENT_COOLDOWN),
  maxPopulation: process.env.MIIU_MAX_POPULATION === undefined ? undefined : Number(process.env.MIIU_MAX_POPULATION),
  spawning: process.env.MIIU_SPAWNING !== "off",
  spawnAffinity: process.env.MIIU_SPAWN_AFFINITY === undefined ? undefined : Number(process.env.MIIU_SPAWN_AFFINITY),
  spawnChance: process.env.MIIU_SPAWN_CHANCE === undefined ? undefined : Number(process.env.MIIU_SPAWN_CHANCE),
  playerSpawning: process.env.MIIU_PLAYER_SPAWNING !== "off",
  socialWander: process.env.MIIU_SOCIAL_WANDER !== "off",
  game: process.env.MIIU_GAME !== "off",
  gameCampaignMs: process.env.MIIU_GAME_CAMPAIGN_MS === undefined ? undefined : Number(process.env.MIIU_GAME_CAMPAIGN_MS),
  gameCooldownMs: process.env.MIIU_GAME_COOLDOWN_MS === undefined ? undefined : Number(process.env.MIIU_GAME_COOLDOWN_MS),
  gameTellWindowMs: process.env.MIIU_GAME_TELL_WINDOW_MS === undefined ? undefined : Number(process.env.MIIU_GAME_TELL_WINDOW_MS),
};

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = normalize(req.url === "/" ? "/index.html" : req.url!.split("?")[0]);
  try {
    const body = await readFile(join(PUBLIC, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server });
const send = (ws: WebSocket, msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: unknown) => wss.clients.forEach((ws) => send(ws, msg));

const sim = new Sim(loadWorld(), (event) => broadcast({ type: "event", event }), { llm, store: nodeStore, config: simConfig });

wss.on("connection", (ws) => {
  send(ws, { type: "init", map: { w: MAP_W, h: MAP_H, landmarks: LANDMARKS }, events: sim.world.events, model: MODEL });
  ws.on("message", (raw) => {
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
  });
});

setInterval(() => broadcast({ type: "state", ...sim.snapshot() }), 200);
process.on("SIGINT", () => { nodeStore.save(sim.world); process.exit(0); });

server.listen(PORT, () => console.log(`MiiU running at http://localhost:${PORT} (model: ${MODEL})`));
