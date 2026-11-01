import { readFileSync, writeFileSync, existsSync } from "node:fs";

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

export interface Relationship {
  a: string;
  b: string;
  affinity: number;
  label: RelLabel;
  lastTalk: number;
  history: string[];
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

export const relKey = (a: string, b: string) => [a, b].sort().join("|");

export function getRel(world: World, a: string, b: string): Relationship {
  const key = relKey(a, b);
  return (world.relationships[key] ??= { a, b, affinity: 0, label: "stranger", lastTalk: 0, history: [] });
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

const FILE = new URL("../world.json", import.meta.url);

export function loadWorld(): World {
  if (existsSync(FILE)) {
    const w = JSON.parse(readFileSync(FILE, "utf8")) as World;
    for (const r of Object.values(w.relationships)) r.lastTalk = 0; // sim clock restarts at 0
    for (const c of w.characters) { c.state = "wandering"; c.bubble = null; c.idleUntil = 0; c.occupation ??= randomOccupation(); } // backfill jobs for pre-#6 saves
    return w;
  }
  const w: World = { characters: SEED.map(newCharacter), relationships: {}, events: [] };
  saveWorld(w);
  return w;
}

export function saveWorld(world: World) {
  writeFileSync(FILE, JSON.stringify(world, null, 2));
}
