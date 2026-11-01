const TILE = 40;
const mapCanvas = document.getElementById("map");
const mctx = mapCanvas.getContext("2d");
const graphCanvas = document.getElementById("graph");
const gctx = graphCanvas.getContext("2d");
const $ = (id) => document.getElementById(id);

let ws;
let map = null;
let state = { characters: [], relationships: [] };
let selectedId = null;
const drawPos = new Map(); // id -> smoothed {x,y}
const nodes = new Map(); // id -> graph node {x,y,vx,vy}

const nameOf = (id) => state.characters.find((c) => c.id === id)?.name ?? "?";
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "init") {
      map = msg.map;
      mapCanvas.width = map.w * TILE;
      mapCanvas.height = map.h * TILE;
      $("feed").innerHTML = "";
      $("eventGather").innerHTML = '<option value="">Nobody moves</option>' +
        map.landmarks.map((l) => `<option value="${esc(l.name)}">Gather at the ${esc(l.name)}</option>`).join("");
      msg.events.forEach(addEvent);
      document.title = `MiiU Island · ${msg.model}`;
    } else if (msg.type === "state") {
      state = msg;
      $("status").textContent = msg.paused ? "⏸ paused" : msg.status === "idle" ? "Everyone is wandering…" : msg.status;
      $("pause").textContent = msg.paused ? "Resume" : "Pause";
      $("eventBtn").disabled = msg.status.startsWith("📣");
      renderTargets();
      renderDetail();
    } else if (msg.type === "event") {
      addEvent(msg.event);
    }
  };
  ws.onclose = () => { $("status").textContent = "disconnected, retrying…"; setTimeout(connect, 1500); };
}
const sendMsg = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

// ---------- map ----------
function drawMap() {
  if (!map) return;
  const { w, h, landmarks } = map;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      mctx.fillStyle = edge ? "#7fc4e8" : (x + y) % 2 ? "#a8d672" : "#9fcf68";
      mctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  }
  for (const l of landmarks) {
    mctx.fillStyle = l.color;
    roundRect(mctx, l.x * TILE, l.y * TILE, l.w * TILE, l.h * TILE, 10);
    mctx.fill();
    mctx.fillStyle = "rgba(0,0,0,.55)";
    mctx.font = "bold 13px system-ui";
    mctx.textAlign = "center";
    mctx.fillText(l.name, (l.x + l.w / 2) * TILE, l.y * TILE - 6);
  }
}

function drawFace(c, x, y) {
  const r = 15;
  if (c.id === selectedId) {
    mctx.strokeStyle = "#fff"; mctx.lineWidth = 4;
    mctx.beginPath(); mctx.arc(x, y, r + 5, 0, Math.PI * 2); mctx.stroke();
  }
  mctx.fillStyle = "rgba(0,0,0,.18)";
  mctx.beginPath(); mctx.ellipse(x, y + r + 2, r * 0.8, 4, 0, 0, Math.PI * 2); mctx.fill();
  mctx.fillStyle = c.color;
  mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();

  mctx.fillStyle = "#222"; mctx.strokeStyle = "#222"; mctx.lineWidth = 2;
  const m = c.mood;
  if (m === "love") {
    mctx.fillStyle = "#e2336b";
    for (const dx of [-5, 5]) { mctx.font = "9px system-ui"; mctx.textAlign = "center"; mctx.fillText("♥", x + dx, y + 1); }
  } else {
    for (const dx of [-5, 5]) { mctx.beginPath(); mctx.arc(x + dx, y - 2, m === "excited" ? 2.6 : 2, 0, Math.PI * 2); mctx.fill(); }
  }
  if (m === "angry") {
    mctx.beginPath(); mctx.moveTo(x - 8, y - 8); mctx.lineTo(x - 3, y - 5); mctx.moveTo(x + 8, y - 8); mctx.lineTo(x + 3, y - 5); mctx.stroke();
  }
  mctx.beginPath();
  if (m === "happy" || m === "love") mctx.arc(x, y + 3, 5, 0.15 * Math.PI, 0.85 * Math.PI);
  else if (m === "sad" || m === "angry") mctx.arc(x, y + 10, 5, 1.2 * Math.PI, 1.8 * Math.PI);
  else if (m === "excited") { mctx.arc(x, y + 5, 3.5, 0, Math.PI * 2); mctx.fillStyle = "#222"; mctx.fill(); }
  else { mctx.moveTo(x - 4, y + 6); mctx.lineTo(x + 4, y + 6); }
  mctx.stroke();

  mctx.font = "600 12px system-ui"; mctx.textAlign = "center";
  const tw = mctx.measureText(c.name).width + 10;
  mctx.fillStyle = "rgba(255,255,255,.85)";
  roundRect(mctx, x - tw / 2, y + r + 5, tw, 17, 8); mctx.fill();
  mctx.fillStyle = "#2d2a26"; mctx.fillText(c.name, x, y + r + 18);
}

function drawBubble(text, x, y) {
  mctx.font = "13px system-ui";
  const lines = wrap(text, 200);
  const lh = 16, pad = 8;
  const w = Math.max(...lines.map((l) => mctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lh + pad * 2 - 4;
  let bx = Math.min(Math.max(x - w / 2, 4), mapCanvas.width - w - 4);
  const by = Math.max(y - 28 - h, 4);
  mctx.fillStyle = "white"; mctx.strokeStyle = "#333"; mctx.lineWidth = 1.5;
  roundRect(mctx, bx, by, w, h, 10); mctx.fill(); mctx.stroke();
  mctx.beginPath(); mctx.moveTo(x - 6, by + h); mctx.lineTo(x, by + h + 9); mctx.lineTo(x + 6, by + h); mctx.closePath(); mctx.fill();
  mctx.fillStyle = "#222"; mctx.textAlign = "left";
  lines.forEach((l, i) => mctx.fillText(l, bx + pad, by + pad + 10 + i * lh));
}

function wrap(text, maxW) {
  const words = text.split(" "), out = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (mctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function frame() {
  drawMap();
  const cs = state.characters;
  for (const c of cs) {
    const p = drawPos.get(c.id) ?? { ...c.pos };
    p.x += (c.pos.x - p.x) * 0.2;
    p.y += (c.pos.y - p.y) * 0.2;
    drawPos.set(c.id, p);
  }
  for (const ids of state.chats ?? []) {
    const ps = ids.map((id) => drawPos.get(id)).filter(Boolean);
    if (ps.length < 2) continue;
    const cx = ps.reduce((t, p) => t + p.x, 0) / ps.length, cy = ps.reduce((t, p) => t + p.y, 0) / ps.length;
    mctx.strokeStyle = "rgba(255,255,255,.75)"; mctx.setLineDash([4, 4]); mctx.lineWidth = 2;
    mctx.beginPath();
    for (const p of ps) { mctx.moveTo(cx * TILE, cy * TILE); mctx.lineTo(p.x * TILE, p.y * TILE); }
    mctx.stroke(); mctx.setLineDash([]);
    mctx.fillStyle = "rgba(255,255,255,.9)";
    mctx.beginPath(); mctx.arc(cx * TILE, cy * TILE, 4, 0, Math.PI * 2); mctx.fill();
  }
  [...cs].sort((a, b) => a.pos.y - b.pos.y).forEach((c) => { const p = drawPos.get(c.id); drawFace(c, p.x * TILE, p.y * TILE); });
  for (const c of cs) if (c.bubble) { const p = drawPos.get(c.id); drawBubble(c.bubble, p.x * TILE, p.y * TILE); }
  drawGraph();
  requestAnimationFrame(frame);
}

mapCanvas.addEventListener("click", (e) => {
  const rect = mapCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * mapCanvas.width / TILE;
  const y = ((e.clientY - rect.top) / rect.height) * mapCanvas.height / TILE;
  let best = null, bestD = 0.8;
  for (const c of state.characters) {
    const p = drawPos.get(c.id) ?? c.pos;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { best = c; bestD = d; }
  }
  selectedId = best?.id ?? null;
  lastDetail = "";
  renderDetail();
});

// ---------- relationship graph ----------
function relColor(r) {
  if (r.label === "crush") return "#e2336b";
  if (r.label === "rival" || r.affinity < 0) return "#d9534f";
  if (r.affinity > 0) return "#3fb57a";
  return "#bbb";
}

function drawGraph() {
  const W = (graphCanvas.width = graphCanvas.clientWidth * devicePixelRatio);
  const H = (graphCanvas.height = graphCanvas.clientHeight * devicePixelRatio);
  gctx.scale(devicePixelRatio, devicePixelRatio);
  const w = W / devicePixelRatio, h = H / devicePixelRatio;
  const cs = state.characters;
  for (const c of cs) if (!nodes.has(c.id)) nodes.set(c.id, { x: w / 2 + (Math.random() - 0.5) * 80, y: h / 2 + (Math.random() - 0.5) * 80, vx: 0, vy: 0 });
  for (const id of nodes.keys()) if (!cs.some((c) => c.id === id)) nodes.delete(id);

  // forces: repulsion between all, springs along relationships (stronger when they like each other)
  const ns = cs.map((c) => nodes.get(c.id));
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const f = 1800 / (d * d);
    a.vx -= (dx / d) * f; a.vy -= (dy / d) * f; b.vx += (dx / d) * f; b.vy += (dy / d) * f;
  }
  for (const r of state.relationships) {
    const a = nodes.get(r.a), b = nodes.get(r.b);
    if (!a || !b) continue;
    const rest = 140 - r.affinity * 0.8;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const f = (d - rest) * 0.004;
    a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
  }
  for (const n of ns) {
    n.vx += (w / 2 - n.x) * 0.002; n.vy += (h / 2 - n.y) * 0.002;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x = Math.min(w - 30, Math.max(30, n.x + n.vx));
    n.y = Math.min(h - 25, Math.max(20, n.y + n.vy));
  }

  gctx.clearRect(0, 0, w, h);
  for (const r of state.relationships) {
    const a = nodes.get(r.a), b = nodes.get(r.b);
    if (!a || !b) continue;
    gctx.strokeStyle = relColor(r);
    gctx.lineWidth = 1 + Math.abs(r.affinity) / 12;
    gctx.beginPath(); gctx.moveTo(a.x, a.y); gctx.lineTo(b.x, b.y); gctx.stroke();
    gctx.font = "10px system-ui"; gctx.textAlign = "center"; gctx.fillStyle = "#6b645b";
    gctx.fillText(r.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
  }
  for (const c of cs) {
    const n = nodes.get(c.id);
    gctx.fillStyle = c.color;
    gctx.beginPath(); gctx.arc(n.x, n.y, c.id === selectedId ? 11 : 9, 0, Math.PI * 2); gctx.fill();
    gctx.fillStyle = "#2d2a26"; gctx.font = "600 11px system-ui"; gctx.textAlign = "center";
    gctx.fillText(c.name, n.x, n.y + 22);
  }
}

// ---------- panels ----------
let lastDetail = "";
function renderDetail() {
  const el = $("detail");
  const c = state.characters.find((x) => x.id === selectedId);
  if (!c) { el.innerHTML = `<h2>Resident</h2><p class="empty">Click someone on the map.</p>`; lastDetail = ""; return; }
  const rels = state.relationships.filter((r) => r.a === c.id || r.b === c.id).sort((a, b) => b.affinity - a.affinity);
  const others = state.characters.filter((o) => o.id !== c.id);
  const html = `<h2>Resident</h2>
    <div class="row" style="justify-content:space-between"><b style="font-size:16px;color:${c.color}">${esc(c.name)}</b><span class="chip">${c.mood}</span></div>
    <p style="margin:6px 0">${esc(c.personality)}</p>
    <div class="meta">❤ ${esc(c.likes || "—")} · ✖ ${esc(c.dislikes || "—")}</div>
    <h2 style="margin-top:10px">Feelings</h2>
    ${rels.length ? rels.map((r) => `<span class="chip" style="background:${relColor(r)}22">${esc(nameOf(r.a === c.id ? r.b : r.a))}: ${r.label} (${r.affinity})</span>`).join("") : '<p class="empty">Hasn\'t met anyone yet.</p>'}
    <h2 style="margin-top:10px">Memories</h2>
    ${c.memories.length ? `<ul>${c.memories.slice().reverse().map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : '<p class="empty">No memories yet.</p>'}
    <div class="row" style="margin-top:8px">
      <select id="talkTo">${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>
      <button id="talkBtn" style="flex:none">Make talk</button>
    </div>
    <button id="delBtn" style="margin-top:4px">Move out</button>`;
  if (html === lastDetail) return; // don't clobber the dropdown while the user is using it
  const keep = $("talkTo")?.value;
  el.innerHTML = html;
  lastDetail = html;
  if (keep && others.some((o) => o.id === keep)) $("talkTo").value = keep;
  $("talkBtn").onclick = () => sendMsg({ type: "talk", a: c.id, b: $("talkTo").value });
  $("delBtn").onclick = () => { if (confirm(`Move ${c.name} off the island?`)) { sendMsg({ type: "delete", id: c.id }); selectedId = null; } };
}

function addEvent(ev) {
  const div = document.createElement("div");
  div.className = ev.kind === "world" ? "ev world" : "ev";
  const time = new Date(ev.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `<div class="meta">${time}${ev.place ? " · " + esc(ev.place) : ""}</div><div>${esc(ev.text)}</div>` +
    (ev.lines ?? []).map((l) => `<div class="line"><b>${esc(l.speaker)}:</b> ${esc(l.text)}</div>`).join("");
  $("feed").prepend(div);
}

$("create").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  sendMsg({ type: "create", ...Object.fromEntries(f) });
  e.target.reset();
});
let lastTargets = "";
function renderTargets() {
  const html = '<option value="">Everyone hears about it</option>' +
    state.characters.map((c) => `<option value="${c.id}">Only ${esc(c.name)}</option>`).join("");
  if (html === lastTargets) return;
  const keep = $("eventTarget").value;
  $("eventTarget").innerHTML = lastTargets = html;
  $("eventTarget").value = state.characters.some((c) => c.id === keep) ? keep : "";
}

const PRESETS = [
  { label: "🎉 Festival", text: "A surprise festival with food stalls and fireworks starts tonight", gather: "Park" },
  { label: "⛈️ Storm", text: "A huge thunderstorm knocks out the power across the island" },
  { label: "💌 Love letter", text: "An unsigned love letter washes up on the shore", gather: "Beach" },
  { label: "🛸 UFO", text: "Strange lights hover over the island at night and then vanish" },
  { label: "☕ Café drama", text: "The café runs out of coffee and the owner blames a resident", gather: "Café" },
  { label: "🏆 Contest", text: "A talent contest is announced with a mysterious grand prize", gather: "Park" },
];
$("presets").innerHTML = PRESETS.map((p, i) => `<button type="button" data-i="${i}">${p.label}</button>`).join("");
$("presets").onclick = (e) => {
  const p = PRESETS[e.target.dataset.i];
  if (!p) return;
  $("event").text.value = p.text;
  $("eventGather").value = p.gather ?? "";
};
$("event").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMsg({ type: "event", ...Object.fromEntries(new FormData(e.target)) });
  e.target.text.value = "";
});
$("pause").onclick = () => sendMsg({ type: "pause" });
$("speed").oninput = (e) => sendMsg({ type: "speed", value: e.target.value });

connect();
requestAnimationFrame(frame);
