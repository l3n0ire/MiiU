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

export interface World {
  characters: Character[];
  relationships: Record<string, Relationship>;
  events: WorldEvent[];
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
  return { characters: SEED.map(newCharacter), relationships: {}, events: [] };
}

// Normalize a loaded/deserialized world for a fresh sim session: the sim clock
// restarts at 0, and older saves may predate the timeline or occupation fields.
export function migrateWorld(w: World): World {
  w.events ??= [];
  w.relationships ??= {};
  for (const r of Object.values(w.relationships)) { r.lastTalk = 0; r.timeline ??= []; }
  for (const c of w.characters) { c.state = "wandering"; c.bubble = null; c.idleUntil = 0; c.occupation ??= randomOccupation(); }
  return w;
}
