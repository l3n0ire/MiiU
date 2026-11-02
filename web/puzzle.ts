// Bridge puzzle page: renders the cooperative bridge-building scene from
// puzzle-engine.ts on a canvas. Chatter (short template lines from the engine)
// is hidden by default - the scene is meant to read from actions alone.
import { BridgePuzzle, PUZZLE_W, PUZZLE_H, RIVER_X0, RIVER_X1, BRIDGE_Y, FLAG, type PuzzleSnapshot, type CrewMember } from "./puzzle-engine.ts";
import { migrateWorld, seedWorld } from "../server/world.ts";

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

let puzzle = new BridgePuzzle(loadCrew());
let showChatter = false;
let confetti: { x: number; y: number; vx: number; vy: number; color: string; t: number }[] = [];
let celebrated = false;

function reset() {
  puzzle = new BridgePuzzle(loadCrew());
  confetti = [];
  celebrated = false;
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

function draw() {
  const s = puzzle.snapshot();
  // banks
  ctx.fillStyle = "#a8d8a0";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // subtle checker for grass texture
  ctx.fillStyle = "rgba(0,0,0,0.03)";
  for (let x = 0; x < PUZZLE_W; x++) for (let y = 0; y < PUZZLE_H; y++) if ((x + y) % 2 === 0) ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  // river
  const wave = Math.sin(s.t * 2) * 3;
  ctx.fillStyle = "#6db6e8";
  ctx.fillRect(RIVER_X0 * TILE, 0, (RIVER_X1 - RIVER_X0 + 1) * TILE, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  for (let y = 0; y < PUZZLE_H; y++) {
    ctx.beginPath();
    for (let x = RIVER_X0; x <= RIVER_X1 + 1; x++) {
      const px = x * TILE, py = y * TILE + TILE / 2 + Math.sin(s.t * 2 + x + y) * 3 + wave * 0.2;
      if (x === RIVER_X0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // goal flag
  const fx = (FLAG.x + 0.5) * TILE, fy = (FLAG.y + 0.5) * TILE;
  ctx.strokeStyle = "#5a4a3a";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(fx, fy + 14); ctx.lineTo(fx, fy - 16); ctx.stroke();
  ctx.fillStyle = "#ff7a59";
  ctx.beginPath(); ctx.moveTo(fx, fy - 16); ctx.lineTo(fx + 16, fy - 10); ctx.lineTo(fx, fy - 4); ctx.closePath(); ctx.fill();
  // bridge cells: dashed outline where a piece is missing
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
      // two handle dots hint it takes two carriers
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
    // initial
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px ui-rounded, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(m.name.slice(0, 1).toUpperCase(), mx, my - 1 - bounce);
    // name
    ctx.fillStyle = "rgba(45,42,38,0.85)";
    ctx.font = "10px ui-rounded, system-ui, sans-serif";
    ctx.fillText(m.name, mx, my + 16 - bounce);
    // action label: what they're doing, always visible
    const labels: Record<string, string> = {
      fetching: "fetching", waiting: "needs help!", helping: "going to help",
      carrying: m.carrying === "beam" ? "carrying together" : "carrying",
      placing: "placing", crossing: "crossing!", celebrating: "🎉",
    };
    const label = labels[m.state];
    if (label) {
      ctx.fillStyle = "rgba(45,42,38,0.6)";
      ctx.font = "italic 9px ui-rounded, system-ui, sans-serif";
      ctx.fillText(label, mx, my + 26 - bounce);
    }
    // chatter bubble: only when the user opted in
    if (showChatter && m.bubble) {
      ctx.font = "11px ui-rounded, system-ui, sans-serif";
      const w = ctx.measureText(m.bubble).width + 14;
      const bx = Math.min(Math.max(mx - w / 2, 4), canvas.width - w - 4);
      const by = my - 44 - bounce;
      ctx.fillStyle = "rgba(255,250,242,0.95)";
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D).roundRect(bx, by - 14, w, 20, 8);
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
  }
  confetti = confetti.filter((c) => c.t < 2.5);
  for (const c of confetti) {
    c.t += 1 / 60; c.x += c.vx / 60; c.y += c.vy / 60; c.vy += 220 / 60;
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, 5, 5);
  }
  // status line
  $("puzzleStatus").textContent = s.paused
    ? "⏸ paused"
    : s.status === "complete"
      ? "🌉 Bridge complete!"
      : `Building the bridge - ${s.placedCount}/${s.totalPieces} pieces placed`;
  ($("pauseBtn") as HTMLButtonElement).textContent = s.paused ? "Resume" : "Pause";
}

let last = performance.now();
let logTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  puzzle.tick(dt);
  draw();
  logTimer += dt;
  if (showChatter && logTimer > 0.5) { logTimer = 0; renderLog(); }
  requestAnimationFrame(frame);
}

$("pauseBtn").addEventListener("click", () => { puzzle.paused = !puzzle.paused; });
$("resetBtn").addEventListener("click", reset);
($("speedRange") as HTMLInputElement).addEventListener("input", (e) => {
  puzzle.speed = Math.max(0.25, Math.min(4, Number((e.target as HTMLInputElement).value) || 1));
});
$("chatterBtn").addEventListener("click", () => {
  showChatter = !showChatter;
  $("chatterBtn").textContent = showChatter ? "🙈 Hide chatter" : "💬 Show chatter";
  $("logPanel").style.display = showChatter ? "" : "none";
  if (showChatter) renderLog();
});

requestAnimationFrame(frame);
