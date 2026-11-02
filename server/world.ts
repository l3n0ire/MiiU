export const MAP_W = 20;
export const MAP_H = 15;

export type Mood = "happy" | "sad" | "angry" | "excited" | "bored" | "love" | "neutral";
export const MOODS: Mood[] = ["happy", "sad", "angry", "excited", "bored", "love", "neutral"];

export type RelLabel =
  | "stranger" | "acquaintance" | "friend" | "best friend"
  | "crush" | "rival" | "family" | "mentor" | "ex"
  | "frenemy" | "coworker" | "neighbor" | "enemy";
export const REL_LABELS: RelLabel[] = [
  "stranger", "acquaintance", "friend", "best friend",
  "crush", "rival", "family", "mentor", "ex",
  "frenemy", "coworker", "neighbor", "enemy",
];

export interface Vec { x: number; y: number }

export interface Character {
  id: string;
  name: string;
  personality: string;
  likes: string;
  dislikes: string;
  color: string;
  pos: Vec;
  target: Vec;
  state: "wandering" | "talking" | "idle";
  idleUntil: number;
  mood: Mood;
  occupation: string; // job role (issue #6); workplace biases wandering
  memories: string[];
  facts: string[]; // durable specifics worth permanent retention (issue #23); capped at 50 on write
  bubble: string | null;
  bubbleUntil?: number;
}

// One recorded change in a pair's story: what the label/affinity became, and what caused it.
export interface RelTimelineEntry {
  t: number; // wall-clock ms
  from: RelLabel | null; // null when the relationship itself begins
  to: RelLabel;
  delta: number; // affinity change applied
  affinity: number; // affinity after the change
  cause: string; // the chat or event behind it
}

export interface Relationship {
  a: string;
  b: string;
  affinity: number;
  label: RelLabel;
  lastTalk: number;
  history: string[];
  timeline: RelTimelineEntry[];
}

// Record a label/affinity change with its cause (issue #12). Call after applying the change.
export function recordRelChange(rel: Relationship, delta: number, cause: string, from: RelLabel | null) {
  rel.timeline.push({ t: Date.now(), from, to: rel.label, delta, affinity: rel.affinity, cause });
  if (rel.timeline.length > 50) rel.timeline.shift();
}

export interface WorldEvent {
  t: number;
  kind: "chat" | "join" | "system" | "world";
  participants: string[];
  place?: string;
  text: string;
  lines?: { speaker: string; text: string }[];
}

export interface Landmark { name: string; x: number; y: number; w: number; h: number; color: string }

export const LANDMARKS: Landmark[] = [
  { name: "Café", x: 3, y: 3, w: 3, h: 2, color: "#c08552" },
  { name: "Park", x: 13, y: 3, w: 4, h: 3, color: "#5a9e4b" },
  { name: "Beach", x: 2, y: 11, w: 5, h: 2, color: "#e8d28c" },
  { name: "Apartments", x: 13, y: 10, w: 4, h: 2, color: "#8a8fb5" },
];


// ---- game layer: festival races, secrets, promises (see server/game.ts) ----
// All deadlines are on the game clock (game.clockMs), advanced only by the running,
// unpaused sim - so closed tabs and paused time never count.

export interface Festival {
  status: "campaigning" | "decided" | "flopped";
  candidates: string[]; // exactly 2 while campaigning
  endorsements: Record<string, string>; // voterId -> candidateId (non-candidates only)
  deadline: number; // game-clock ms
  winner: string | null;
  nextAt: number | null; // game-clock ms when the next race is announced
}

export interface Secret {
  id: string;
  subject: string; // resident id the secret is about
  text: string;
  knownBy: string[]; // resident ids (may include the player)
  toldBy: Record<string, string | null>; // knower -> who told them (null = self)
  exposed: boolean;
}

export interface Pledge {
  id: string;
  promiser: string;
  promisee: string; // may be the player
  kind: "keep_secret" | "tell_secret";
  secret: string; // secret id
  deadline: number; // game-clock ms
  status: "active" | "kept" | "broken";
  race?: number; // festival sequence the promise was made in (0 = pre-race); kept-promise trust decays per promiser per race
}

export interface GameState {
  clockMs: number;
  festival: Festival | null;
  secrets: Secret[];
  pledges: Pledge[];
  raceSeq?: number; // incremented each time a festival race starts
}

export interface World {
  characters: Character[];
  relationships: Record<string, Relationship>;
  events: WorldEvent[];
  game: GameState;
}

// Persistence hook: the Node server saves to world.json, the browser app to localStorage.
export interface WorldStore {
  save(world: World): void;
}

export const relKey = (a: string, b: string) => [a, b].sort().join("|");

export function getRel(world: World, a: string, b: string): Relationship {
  const key = relKey(a, b);
  return (world.relationships[key] ??= { a, b, affinity: 0, label: "stranger", lastTalk: 0, history: [], timeline: [] });
}

export function placeName(pos: Vec): string {
  for (const l of LANDMARKS) {
    if (pos.x >= l.x - 1.5 && pos.x <= l.x + l.w + 1.5 && pos.y >= l.y - 1.5 && pos.y <= l.y + l.h + 1.5) return l.name;
  }
  return "a path on the island";
}

export function randomWalkable(): Vec {
  if (Math.random() < 0.5) {
    const l = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
    return { x: l.x + Math.random() * l.w, y: l.y + Math.random() * l.h };
  }
  return { x: 1.5 + Math.random() * (MAP_W - 3), y: 1.5 + Math.random() * (MAP_H - 3) };
}

export function newCharacter(input: Pick<Character, "name" | "personality" | "likes" | "dislikes" | "color"> & { occupation?: string }): Character {
  const pos = randomWalkable();
  return {
    id: Math.random().toString(36).slice(2, 10),
    occupation: randomOccupation(),
    ...input,
    pos,
    target: randomWalkable(),
    state: "wandering",
    idleUntil: 0,
    mood: "neutral",
    memories: [],
    facts: [],
    bubble: null,
  };
}

// Occupation roles (issue #6): each resident has a job; landmark-bound jobs
// pull their wandering toward the workplace.
export const OCCUPATIONS: { job: string; place: string | null }[] = [
  { job: "Barista", place: "Café" },
  { job: "Groundskeeper", place: "Park" },
  { job: "Lifeguard", place: "Beach" },
  { job: "Superintendent", place: "Apartments" },
];
export const randomOccupation = () => OCCUPATIONS[Math.floor(Math.random() * OCCUPATIONS.length)].job;
export const workplaceFor = (occupation: string): Landmark | undefined => {
  const place = OCCUPATIONS.find((o) => o.job === occupation)?.place;
  return place ? LANDMARKS.find((l) => l.name === place) : undefined;
};

const SEED = [
  { name: "Pip", personality: "Hyper, optimistic, talks in exclamation marks, wants to be a famous chef", likes: "spicy food, karaoke", dislikes: "mornings", color: "#ff7a59" },
  { name: "Marlo", personality: "Dry-witted, secretly sentimental, reads too many mystery novels", likes: "tea, rainy days", dislikes: "loud people", color: "#4a90d9" },
  { name: "Juniper", personality: "Dreamy artist who believes the moon is watching her", likes: "painting, stargazing", dislikes: "math", color: "#b36bd6" },
  { name: "Gus", personality: "Competitive gym bro with a heart of gold, terrible at flirting", likes: "protein shakes, frisbee", dislikes: "losing", color: "#3fb57a" },
];

// A fresh island with the default residents.
export function seedWorld(): World {
  return { characters: SEED.map(newCharacter), relationships: {}, events: [], game: { clockMs: 0, festival: null, secrets: [], pledges: [] } };
}

// Normalize a loaded/deserialized world for a fresh sim session: the sim clock
// restarts at 0, and older saves may predate the timeline or occupation fields.
// --- Import/load hardening (issue #19 audit): island files are untrusted input.
// Coerce every field to its expected type, bound string lengths, whitelist enums and
// colors, drop malformed entries, and keep only relationships between known residents.
const cleanStr = (v: unknown, max = 300): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
const cleanNum = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const cleanColor = (v: unknown): string =>
  typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : "#888888";
const cleanVec = (v: unknown): Vec => {
  const p = (v ?? {}) as Vec;
  return { x: clamp(cleanNum(p.x, MAP_W / 2), 0, MAP_W), y: clamp(cleanNum(p.y, MAP_H / 2), 0, MAP_H) };
};
const PLAYER_ID = "__user__";
const EVENT_KINDS = ["chat", "join", "system", "world"];

export function migrateWorld(w: World): World {
  const src = (w ?? {}) as World;
  const out: World = { characters: [], relationships: {}, events: [], game: { clockMs: 0, festival: null, secrets: [], pledges: [] } };
  const ids = new Set<string>();
  const chars = Array.isArray(src.characters) ? src.characters : [];
  for (const c of chars.slice(0, 40)) {
    if (!c || typeof c !== "object") continue;
    const id = cleanStr(c.id, 40) || `c${ids.size + 1}`;
    if (ids.has(id) || id === PLAYER_ID) continue;
    const mood = (MOODS as string[]).includes(c.mood) ? c.mood : "neutral";
    out.characters.push({
      id,
      name: cleanStr(c.name, 40) || "Islander",
      personality: cleanStr(c.personality, 500),
      likes: cleanStr(c.likes, 200),
      dislikes: cleanStr(c.dislikes, 200),
      color: cleanColor(c.color),
      pos: cleanVec(c.pos),
      target: cleanVec(c.target),
      state: "wandering",
      idleUntil: 0,
      mood,
      occupation: cleanStr(c.occupation, 80) || randomOccupation(),
      memories: (Array.isArray(c.memories) ? c.memories : []).slice(-30).map((m) => cleanStr(m)).filter(Boolean),
      facts: (Array.isArray(c.facts) ? c.facts : []).slice(-50).map((f) => cleanStr(f, 200)).filter(Boolean),
      bubble: null,
    });
    ids.add(id);
  }
  for (const r of Object.values(src.relationships ?? {})) {
    if (!r || typeof r !== "object") continue;
    const a = cleanStr(r.a, 40), b = cleanStr(r.b, 40);
    const known = (x: string) => ids.has(x) || x === PLAYER_ID;
    if (!a || !b || a === b || !known(a) || !known(b)) continue;
    out.relationships[relKey(a, b)] = {
      a, b,
      affinity: clamp(cleanNum(r.affinity), -100, 100),
      label: (REL_LABELS as string[]).includes(r.label) ? r.label : "stranger",
      lastTalk: 0,
      history: (Array.isArray(r.history) ? r.history : []).slice(-30).map((h) => cleanStr(h)).filter(Boolean),
      timeline: (Array.isArray(r.timeline) ? r.timeline : []).slice(-50).map((e) => ({
        t: cleanNum(e?.t),
        from: (REL_LABELS as string[]).includes(e?.from ?? "") ? e.from : null,
        to: (REL_LABELS as string[]).includes(e?.to ?? "") ? e.to : "stranger",
        delta: clamp(cleanNum(e?.delta), -100, 100),
        affinity: clamp(cleanNum(e?.affinity), -100, 100),
        cause: cleanStr(e?.cause),
      })),
    };
  }
  const events = Array.isArray(src.events) ? src.events : [];
  for (const ev of events.slice(-200)) {
    if (!ev || typeof ev !== "object") continue;
    out.events.push({
      t: cleanNum(ev.t),
      kind: EVENT_KINDS.includes(ev.kind) ? ev.kind : "system",
      participants: (Array.isArray(ev.participants) ? ev.participants : []).slice(0, 40).map((p) => cleanStr(p, 40)).filter(Boolean),
      ...(ev.place ? { place: cleanStr(ev.place, 60) } : {}),
      text: cleanStr(ev.text, 500),
      ...(Array.isArray(ev.lines) ? { lines: ev.lines.slice(0, 50).map((l) => ({ speaker: cleanStr(l?.speaker, 40), text: cleanStr(l?.text) })) } : {}),
    });
  }

  // Game state (festival races, secrets, pledges): same untrusted-input rules.
  // References to unknown residents are dropped; the player id stays valid.
  const g = (src.game ?? {}) as GameState;
  const knownId = (x: unknown): x is string => typeof x === "string" && (ids.has(x) || x === PLAYER_ID);
  out.game.clockMs = Math.max(0, cleanNum(g.clockMs));
  out.game.raceSeq = Math.max(0, cleanNum(g.raceSeq));
  const gf = (g.festival ?? null) as Festival | null;
  if (gf && typeof gf === "object") {
    const status = (["campaigning", "decided", "flopped"] as const).includes(gf.status as never) ? gf.status : "flopped";
    const candidates = (Array.isArray(gf.candidates) ? gf.candidates : []).filter(knownId).slice(0, 8);
    const endorsements: Record<string, string> = {};
    for (const [v, c] of Object.entries(gf.endorsements ?? {})) {
      // Voters must be known non-candidates (candidates never vote; runtime rule).
      if (knownId(v) && !candidates.includes(v) && typeof c === "string" && candidates.includes(c)) endorsements[v] = c;
    }
    out.game.festival = {
      status, candidates, endorsements,
      deadline: cleanNum(gf.deadline),
      winner: typeof gf.winner === "string" && candidates.includes(gf.winner) ? gf.winner : null,
      nextAt: typeof gf.nextAt === "number" && Number.isFinite(gf.nextAt) ? gf.nextAt : null,
    };
  }
  const secrets: Secret[] = [];
  for (const s of (Array.isArray(g.secrets) ? g.secrets : []).slice(0, 80)) {
    if (!s || typeof s !== "object" || !knownId(s.subject)) continue;
    const text = cleanStr(s.text, 300);
    if (!text) continue;
    const knownBy = (Array.isArray(s.knownBy) ? s.knownBy : []).filter(knownId);
    if (!knownBy.includes(s.subject)) knownBy.unshift(s.subject);
    const toldBy: Record<string, string | null> = {};
    for (const k of knownBy) {
      const from = (s.toldBy ?? {})[k];
      toldBy[k] = k === s.subject ? null : knownId(from) ? from : null;
    }
    secrets.push({ id: cleanStr(s.id, 60) || `sec${secrets.length + 1}`, subject: s.subject, text, knownBy, toldBy, exposed: s.exposed === true });
  }
  out.game.secrets = secrets;
  const secIds = new Set(secrets.map((s) => s.id));
  for (const p of (Array.isArray(g.pledges) ? g.pledges : []).slice(0, 100)) {
    if (!p || typeof p !== "object") continue;
    if (!knownId(p.promiser) || !knownId(p.promisee) || !secIds.has(p.secret)) continue;
    if (p.kind !== "keep_secret" && p.kind !== "tell_secret") continue;
    out.game.pledges.push({
      id: cleanStr(p.id, 60) || `plg${out.game.pledges.length + 1}`,
      promiser: p.promiser, promisee: p.promisee, kind: p.kind, secret: p.secret,
      deadline: cleanNum(p.deadline),
      status: (["active", "kept", "broken"] as const).includes(p.status as never) ? p.status : "broken",
      race: Math.max(0, cleanNum(p.race)),
    });
  }
  return out;
}
