// The Stone Maze: a cooperative contraption puzzle - pure logic, no DOM, no LLM.
//
// WHAT THIS DEMONSTRATES (read before claiming what this is):
// A generated maze splits into two sealed regions: the camp side (west) and
// the warrens (east) where the supply crates sit. The ONLY public way through
// is a stone door that opens ONLY while TWO miis stand holding its two
// pressure plates at the same time. One mii cannot finish this puzzle alone:
// holders must keep holding while carriers shuttle crates through, and the
// door slams shut the moment a holder steps off - a carrier mid-trip is stuck
// on its side until the door opens again.
//
// Somewhere along the boundary walls a hidden crack may lead into a sealed
// cache room with a golden bonus crate. Nobody knows where (or whether the
// wall has one) until a mii deliberately scouts the boundary up close - an
// errand-runner walking past never examines the walls. The crack is PRIVATE
// knowledge: impassable in a mii's pathfinding until that mii (a) discovers
// it by scouting, or (b) is told by the crew, i.e. the discoverer CHOSE to
// share. Sharing is never automatic. The cache is a bonus: the four supply
// crates win the run, the cache is extra glory.
//
// DECISION MECHANISM: per-mii decisions through a MazeController
// (web/maze-minds.ts when a model is connected): each mii chooses to fetch a
// crate, hold a plate, release its plate, scout the walls, share a discovery
// it personally made, or wait. The engine revalidates every decision (crate
// free, plate free, scout target genuinely unscouted, share only for an
// unshared personal discovery with sharing enabled). Movement, pathing,
// pickup, delivery and the door's open/shut physics stay code-driven. Route
// changes after a share are automatic re-planning with the new knowledge -
// the feed says exactly that.
//
// Without a controller the built-in coordinator assigns two holders and sends
// the others fetching - code-driven cooperation that completes the puzzle but
// never scouts and never shares, so it never finds the cache. The UI says so.
//
// RANDOMIZATION: every layout is generated from the seed (maze, door, plates,
// camp, crates, crack) and REJECTED/regenerated unless a solvability checker
// proves: both plates, camp and spawns reachable with the door shut; every
// crate reachable through the open door; the cache room sealed except through
// its crack. generateMazeLayout only returns checked layouts.
//
// COMPARISON: a sharing on/off toggle plus same-layout restart lets a viewer
// compare runs. Those stats are descriptive (model choices are stochastic);
// they are not a controlled experiment.
//
// THE JAILER: a jailer starts near the middle of the completion path (the
// midpoint of the camp-to-farthest-crate route) and wanders around its post.
// It has straight-corridor line of sight: spot a mii down a corridor and it
// runs at it. On contact the mii is dragged to the jail (a camp-side dead
// end), the jailer vanishes, and a jail key appears somewhere on the map.
// Another mii can fetch the key and free the captive - then the jailer
// respawns far from the crew (the reachable cell with the greatest minimum
// path distance to any free mii) and re-posts there, patrolling that far
// corner instead of returning to the middle next to the rescue. One captive
// at a time (it is gone while someone is
// jailed). The crew can still finish without freeing anyone. After the FIRST
// capture every mii knows to avoid the jailer: they route around it when they
// can and run from it when it chases.

export interface Vec { x: number; y: number }
export interface CrewMember { id: string; name: string; color: string }

export const MAZE_W = 21;
export const MAZE_H = 13;

const BASE_SPEED = 3; // tiles per second at speed=1
const SIGHT = 1.8; // scouting discovery radius around the crack
const PICKUP_DIST = 0.6;
const DELIVER_DIST = 0.9;
const PLATE_DIST = 0.4;
const DISPATCH_EVERY = 0.4; // seconds of scaled time between decision rounds
const REPATH_EVERY = 0.5; // waiting members re-try their route this often
const JAILER_SIGHT = 6; // straight-corridor line of sight, in tiles
const JAILER_WANDER_RADIUS = 4; // manhattan distance the jailer roams from its post
const JAILER_CHASE_SPEED = 3.6; // tiles per second at speed=1 (miis move at BASE_SPEED)
const JAILER_WANDER_SPEED = 1.5;
const JAILER_LOSE_SIGHT = 2.5; // scaled seconds without sight before the chase is dropped
const CAPTURE_DIST = 0.55;
const FLEE_SPEED_MULT = 1.3; // alerted miis outrun the jailer unless cornered
const AVOID_RADIUS = 2; // alerted miis route around cells this close to the jailer

export type MemberState =
  | "idle" | "wandering" | "scouting" | "toPlate" | "holding"
  | "fetching" | "carrying" | "celebrating"
  | "jailed" | "fleeing" | "toKey" | "toJail";

export interface Member {
  id: string;
  name: string;
  color: string;
  pos: Vec;
  path: Vec[];
  state: MemberState;
  crate: string | null;
  plate: string | null; // plate id while toPlate/holding
  bubble: string | null;
  bubbleUntil: number;
  wanderT: number;
  repathT: number;
}

export interface Crate {
  id: string;
  pos: Vec;
  home: Vec;
  claimedBy: string | null;
  delivered: boolean;
  golden: boolean; // the hidden cache crate
}

export interface Plate {
  id: string;
  pos: Vec;
  heldBy: string | null;
  claimedBy: string | null; // a mii on its way to hold it
}

export interface FeedLine { t: number; speaker: string; text: string }

export interface CellEdge { ax: number; ay: number; bx: number; by: number }

export interface MazeLayout {
  carved: string[]; // carved corridor edge keys
  door: CellEdge; // the stone door edge (carved, but gated)
  plates: { id: string; pos: Vec }[];
  camp: Vec;
  spawns: Vec[];
  crates: { id: string; home: Vec }[];
  crack: CellEdge | null; // hidden edge into the sealed cache room (a = camp side)
  cache: { id: string; home: Vec } | null;
  chamber: Vec | null; // the sealed cache room cell
  jail: Vec; // the jail cell: a camp-side dead end
  jailerPost: Vec; // where the jailer starts: mid completion path (after a rescue it re-posts far from the crew)
}

export interface JailerState {
  active: boolean; // false while a captive sits in jail (one capture at a time)
  pos: Vec;
  post: Vec;
  path: Vec[];
  targetId: string | null; // the mii it is chasing
  loseT: number; // scaled seconds since the target was last seen
  wanderT: number;
}

export interface JailKey {
  pos: Vec;
  claimedBy: string | null; // a mii on its way to pick it up
  carriedBy: string | null; // a mii carrying it to the jail
}

// Per-member decision surface. It contains ONLY what this mii knows: the
// crack and the cache room appear only to miis that discovered them or were
// told, and crate route lengths are computed with that mii's own knowledge.
export interface MazeMemberView {
  me: { id: string; name: string; x: number; y: number; carrying: boolean; holding: string | null };
  others: { id: string; name: string; doing: string; x: number; y: number }[];
  delivered: number;
  total: number;
  door: {
    x: number; y: number; // the door's camp-side cell (where you queue)
    open: boolean;
    plates: { id: string; x: number; y: number; heldBy: string | null; claimedBy: string | null }[];
  };
  crates: {
    id: string;
    x: number | null; y: number | null; // null while carried: live positions must not leak routes
    claimedBy: string | null; delivered: boolean;
    carriedBy: string | null;
    routeTiles: number | null; // one-way path length with THIS mii's knowledge (door assumed open)
  }[];
  cache: { x: number; y: number; claimedBy: string | null; delivered: boolean; routeTiles: number | null } | null;
  camp: Vec;
  crackIKnow: { x: number; y: number; foundBy: string } | null; // camp-side cell of the crack
  iFoundUnshared: { x: number; y: number } | null;
  canScout: boolean;
  sharingAllowed: boolean;
  announcements: string[]; // public board: claims, holds and shares only
  // the jailer is a visible character on the map: everyone sees where it is,
  // but the crew only knows to AVOID it after the first capture
  jailer: { active: boolean; x: number; y: number; chasing: string | null };
  jail: { x: number; y: number };
  captive: { id: string; name: string } | null;
  key: { x: number; y: number; claimedBy: string | null; carriedBy: string | null } | null;
  jailerAlert: boolean; // true once the first mii has been captured
}

export interface MazeDecision {
  action: "fetch" | "hold" | "release" | "scout" | "share" | "rescue" | "wait";
  crate?: string;
  plate?: string;
  reason: string;
}

export interface MazeController {
  decide(view: MazeMemberView): MazeDecision | "pending" | "fallback";
  applied?(memberId: string, d: MazeDecision): void;
  rejected?(memberId: string, d: MazeDecision, why: string): void;
  budgetExhausted?(): boolean;
  runFailed?(): void; // the run just failed on the budget wall - freeze minds, discard late replies
}

export interface MazeSnapshot {
  t: number;
  elapsed: number;
  status: "running" | "complete" | "failed";
  failureReason: string | null;
  paused: boolean;
  speed: number;
  seed: number;
  w: number;
  h: number;
  carved: string[];
  door: CellEdge & { open: boolean };
  plates: { id: string; x: number; y: number; heldBy: string | null; claimedBy: string | null }[];
  crack: (CellEdge & { foundByAnyone: boolean; sharedBy: string | null; knownBy: string[] }) | null;
  chamber: Vec | null;
  camp: Vec;
  members: (CrewMember & { x: number; y: number; state: MemberState; carrying: boolean; bubble: string | null; path: Vec[] })[];
  crates: { id: string; x: number; y: number; claimedBy: string | null; delivered: boolean; golden: boolean }[];
  delivered: number;
  total: number;
  sharingAllowed: boolean;
  jail: Vec;
  jailer: { active: boolean; x: number; y: number; chasing: string | null };
  key: { x: number; y: number; claimedBy: string | null; carriedBy: string | null } | null;
  captiveId: string | null;
  jailerAlert: boolean;
  log: FeedLine[];
  stats: {
    discoveries: { by: string; name: string; t: number }[];
    shares: { by: string; name: string; t: number }[];
    routeUpdates: { member: string; name: string; via: string; t: number }[];
    cacheDeliveredBy: string | null;
    captures: { mii: string; name: string; t: number }[];
    rescues: { by: string; name: string; freed: string; t: number }[];
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const center = (v: Vec): Vec => ({ x: Math.floor(v.x) + 0.5, y: Math.floor(v.y) + 0.5 });
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const key = (x: number, y: number) => `${x},${y}`;

function ekey(ax: number, ay: number, bx: number, by: number): string {
  return ax < bx || (ax === bx && ay <= by) ? `${ax},${ay}|${bx},${by}` : `${bx},${by}|${ax},${ay}`;
}
function parseEkey(k: string): CellEdge {
  const [a, b] = k.split("|");
  const [ax, ay] = a.split(",").map(Number);
  const [bx, by] = b.split(",").map(Number);
  return { ax, ay, bx, by };
}
const sameCell = (x1: number, y1: number, x2: number, y2: number) => x1 === x2 && y1 === y2;
function edgeIs(e: CellEdge, ax: number, ay: number, bx: number, by: number): boolean {
  return (sameCell(e.ax, e.ay, ax, ay) && sameCell(e.bx, e.by, bx, by))
    || (sameCell(e.ax, e.ay, bx, by) && sameCell(e.bx, e.by, ax, ay));
}

// Iterative-backtracker perfect maze over the full grid; returns carved edges.
function carveMaze(rng: () => number): Set<string> {
  const carved = new Set<string>();
  const seen = new Set<string>();
  const stack: Vec[] = [{ x: Math.floor(rng() * MAZE_W), y: Math.floor(rng() * MAZE_H) }];
  seen.add(key(stack[0].x, stack[0].y));
  while (stack.length) {
    const c = stack[stack.length - 1];
    const opts: Vec[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
      if (!seen.has(key(nx, ny))) opts.push({ x: nx, y: ny });
    }
    if (!opts.length) { stack.pop(); continue; }
    const n = opts[Math.floor(rng() * opts.length)];
    carved.add(ekey(c.x, c.y, n.x, n.y));
    seen.add(key(n.x, n.y));
    stack.push(n);
  }
  return carved;
}

// BFS over cells using a given edge set; returns distance map.
function bfs(edges: Set<string>, from: Vec): Map<string, number> {
  const d = new Map<string, number>();
  const s = { x: Math.floor(from.x), y: Math.floor(from.y) };
  d.set(key(s.x, s.y), 0);
  const q = [s];
  while (q.length) {
    const c = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
      const nk = key(nx, ny);
      if (d.has(nk) || !edges.has(ekey(c.x, c.y, nx, ny))) continue;
      d.set(nk, d.get(key(c.x, c.y))! + 1);
      q.push({ x: nx, y: ny });
    }
  }
  return d;
}

// The solvability checker every generated layout must pass.
export function verifyMazeLayout(l: MazeLayout): boolean {
  const carved = new Set(l.carved);
  const doorK = ekey(l.door.ax, l.door.ay, l.door.bx, l.door.by);
  if (!carved.has(doorK)) return false;
  const shut = new Set([...carved].filter((k) => k !== doorK)); // door closed
  const reachShut = bfs(shut, l.camp);
  for (const s of l.spawns) if (!reachShut.has(key(s.x, s.y))) return false;
  for (const p of l.plates) if (!reachShut.has(key(p.pos.x, p.pos.y))) return false;
  if (!reachShut.has(key(l.door.ax, l.door.ay))) return false; // door queue cell reachable
  if (reachShut.has(key(l.door.bx, l.door.by))) return false; // door is the ONLY public way east
  // crates only reachable through the OPEN door
  const reachOpen = bfs(carved, l.camp);
  for (const c of l.crates) {
    if (reachShut.has(key(c.home.x, c.home.y))) return false; // must require the door
    if (!reachOpen.has(key(c.home.x, c.home.y))) return false;
  }
  if (l.crack && l.chamber && l.cache) {
    // the cache room is sealed except through the crack
    if (reachOpen.has(key(l.chamber.x, l.chamber.y))) return false;
    if (carved.has(ekey(l.crack.ax, l.crack.ay, l.crack.bx, l.crack.by))) return false; // crack must be HIDDEN (not carved)
    const withCrack = new Set([...carved, ekey(l.crack.ax, l.crack.ay, l.crack.bx, l.crack.by)]);
    if (!bfs(withCrack, l.camp).has(key(l.chamber.x, l.chamber.y))) return false;
    if (!sameCell(l.cache.home.x, l.cache.home.y, l.chamber.x, l.chamber.y)) return false;
  }
  return true;
}

// Generate a solvability-checked layout: maze, camp side vs warrens split by
// the stone door, two pressure plates near the door, four crates deep in the
// warrens, and (for most seeds) a hidden crack into a sealed cache room.
export function generateMazeLayout(seed: number): MazeLayout {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rng = mulberry32((seed * 2654435761 + attempt * 1013904223 + 555) >>> 0);
    const carved = carveMaze(rng);
    // Door candidates: carved edges whose removal disconnects the maze with
    // both sides big enough and on the right sides of the island.
    const all = [...carved].map(parseEkey);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    for (const door of all) {
      const layout = tryDoor(rng, carved, door);
      if (layout && verifyMazeLayout(layout)) return layout;
    }
  }
  throw new Error(`no solvable maze layout for seed ${seed}`);
}

function tryDoor(rng: () => number, carved: Set<string>, door: CellEdge): MazeLayout | null {
  const doorK = ekey(door.ax, door.ay, door.bx, door.by);
  const shut = new Set([...carved].filter((k) => k !== doorK));
  const da = bfs(shut, { x: door.ax, y: door.ay });
  if (da.has(key(door.bx, door.by))) return null; // not the only crossing
  const aCount = da.size;
  const bCount = MAZE_W * MAZE_H - aCount;
  if (aCount < 50 || bCount < 40) return null;
  // door oriented camp-side west of the warrens
  if (!(door.ax <= door.bx)) return null;
  const aCells: Vec[] = [];
  const bCells: Vec[] = [];
  for (let x = 0; x < MAZE_W; x++) for (let y = 0; y < MAZE_H; y++) {
    (da.has(key(x, y)) ? aCells : bCells).push({ x, y });
  }
  const aMinX = Math.min(...aCells.map((c) => c.x));
  const bMaxX = Math.max(...bCells.map((c) => c.x));
  if (aMinX > 2 || bMaxX < MAZE_W - 3) return null;

  const distFromA = (v: Vec) => da.get(key(v.x, v.y));
  const shuffled = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // plates: A-side cells a short walk from the door's A cell
  const plateCells = shuffled(aCells.filter((c) => {
    const d = distFromA(c);
    return d !== undefined && d >= 2 && d <= 6 && !sameCell(c.x, c.y, door.ax, door.ay);
  }));
  if (plateCells.length < 2) return null;
  const plates = plateCells.slice(0, 2).map((c, i) => ({ id: `plate-${i}`, pos: { ...c } }));

  // camp: A-side far west, away from plates and the door
  const occupied = new Set([key(door.ax, door.ay), ...plates.map((p) => key(p.pos.x, p.pos.y))]);
  const campCells = aCells.filter((c) =>
    c.x <= aMinX + 1 && !occupied.has(key(c.x, c.y))
    && plates.every((p) => Math.abs(p.pos.x - c.x) + Math.abs(p.pos.y - c.y) >= 3));
  if (!campCells.length) return null;
  const camp = campCells[Math.floor(rng() * campCells.length)];
  occupied.add(key(camp.x, camp.y));

  // spawns: A-side cells near the camp, distinct
  const spawnCells = shuffled(aCells.filter((c) =>
    !occupied.has(key(c.x, c.y))
    && Math.abs(c.x - camp.x) + Math.abs(c.y - camp.y) >= 1
    && Math.abs(c.x - camp.x) + Math.abs(c.y - camp.y) <= 5));
  if (spawnCells.length < 4) return null;
  const spawns = spawnCells.slice(0, 4).map((c) => ({ ...c }));
  for (const s of spawns) occupied.add(key(s.x, s.y));

  // crates: deep in the warrens (measured through the open door)
  const dOpen = bfs(carved, { x: door.bx, y: door.by });
  const crateCells = shuffled(bCells.filter((c) => (dOpen.get(key(c.x, c.y)) ?? 0) >= 4));
  if (crateCells.length < 4) return null;
  const crates = crateCells.slice(0, 4).map((c, i) => ({ id: `crate-${i}`, home: { ...c } }));

  // hidden crack: an uncarved boundary edge from the camp side into a B-side
  // dead-end cell, which becomes the sealed cache room (70% of layouts)
  let crack: CellEdge | null = null;
  let chamber: Vec | null = null;
  let cache: { id: string; home: Vec } | null = null;
  if (rng() < 0.7) {
    const bDeg = new Map<string, number>();
    for (const k of carved) {
      const e = parseEkey(k);
      bDeg.set(key(e.ax, e.ay), (bDeg.get(key(e.ax, e.ay)) ?? 0) + 1);
      bDeg.set(key(e.bx, e.by), (bDeg.get(key(e.bx, e.by)) ?? 0) + 1);
    }
    const crateSet = new Set(crates.map((c) => key(c.home.x, c.home.y)));
    const options: { a: Vec; b: Vec; d: number }[] = [];
    for (const b of bCells) {
      if ((bDeg.get(key(b.x, b.y)) ?? 0) !== 1) continue; // dead ends only
      if (crateSet.has(key(b.x, b.y))) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = { x: b.x + dx, y: b.y + dy };
        if (a.x < 0 || a.y < 0 || a.x >= MAZE_W || a.y >= MAZE_H) continue;
        if (!da.has(key(a.x, a.y))) continue; // neighbor must be camp side
        const d = distFromA(a) ?? 0;
        if (d >= 3) options.push({ a, b, d });
      }
    }
    if (options.length) {
      options.sort((p, q) => q.d - p.d);
      const pick = options[Math.floor(rng() * Math.min(4, options.length))];
      crack = { ax: pick.a.x, ay: pick.a.y, bx: pick.b.x, by: pick.b.y };
      chamber = { ...pick.b };
      cache = { id: "cache-0", home: { ...pick.b } };
      // Seal the cache room: carve away its maze edges so the hidden crack is
      // the ONLY way in. The room was a dead end, so removing its one edge
      // cannot disconnect anything else. Its carved edges only lead east
      // (a carved edge to the camp side would be a second public crossing,
      // which the door-cut check above already forbids).
      for (const k of [...carved]) {
        const e = parseEkey(k);
        if (sameCell(e.ax, e.ay, pick.b.x, pick.b.y) || sameCell(e.bx, e.by, pick.b.x, pick.b.y)) carved.delete(k);
      }
    }
  }

  // the jail: the deepest camp-side dead end away from camp and the plates.
  // Deterministic from the carved maze - no rng draws, so layouts for every
  // seed are exactly what they were before the jailer existed.
  const degShut = new Map<string, number>();
  for (const k of carved) {
    if (k === doorK) continue;
    const e = parseEkey(k);
    degShut.set(key(e.ax, e.ay), (degShut.get(key(e.ax, e.ay)) ?? 0) + 1);
    degShut.set(key(e.bx, e.by), (degShut.get(key(e.bx, e.by)) ?? 0) + 1);
  }
  let jailCells = aCells.filter((c) =>
    (degShut.get(key(c.x, c.y)) ?? 0) === 1
    && !occupied.has(key(c.x, c.y))
    && Math.abs(c.x - camp.x) + Math.abs(c.y - camp.y) >= 4
    && plates.every((p) => Math.abs(p.pos.x - c.x) + Math.abs(p.pos.y - c.y) >= 3));
  if (!jailCells.length) {
    jailCells = aCells.filter((c) =>
      !occupied.has(key(c.x, c.y))
      && Math.abs(c.x - camp.x) + Math.abs(c.y - camp.y) >= 3);
  }
  if (!jailCells.length) return null;
  jailCells.sort((p, q) => (distFromA(q) ?? 0) - (distFromA(p) ?? 0)
    || p.x - q.x || p.y - q.y);
  const jail = { ...jailCells[0] };

  // the jailer's post: the midpoint of the completion path (camp, through the
  // door, to the farthest crate) - it patrols the route the crew must run
  let farthest = crates[0];
  for (const c of crates) if ((dOpen.get(key(c.home.x, c.home.y)) ?? 0) >= (dOpen.get(key(farthest.home.x, farthest.home.y)) ?? 0)) farthest = c;
  const route = (() => {
    const prev = new Map<string, string>();
    const q = [{ x: camp.x, y: camp.y }];
    const seen = new Set([key(camp.x, camp.y)]);
    while (q.length) {
      const c = q.shift()!;
      if (c.x === farthest.home.x && c.y === farthest.home.y) {
        const out: Vec[] = [];
        let k = key(c.x, c.y);
        while (k !== key(camp.x, camp.y)) {
          const [x, y] = k.split(",").map(Number);
          out.unshift({ x, y });
          k = prev.get(k)!;
        }
        return out;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
        const nk = key(nx, ny);
        if (seen.has(nk) || !carved.has(ekey(c.x, c.y, nx, ny))) continue;
        seen.add(nk); prev.set(nk, key(c.x, c.y)); q.push({ x: nx, y: ny });
      }
    }
    return null;
  })();
  if (!route || route.length < 2) return null;
  const jailerPost = { ...route[Math.floor(route.length / 2)] };

  return {
    carved: [...carved],
    door,
    plates,
    camp,
    spawns,
    crates,
    crack,
    cache,
    chamber,
    jail,
    jailerPost,
  };
}

export class Maze {
  members: Member[] = [];
  crates: Crate[] = [];
  plates: Plate[] = [];
  t = 0;
  elapsed = 0;
  speed = 1;
  paused = false;
  status: "running" | "complete" | "failed" = "running";
  failureReason: string | null = null;
  sharingAllowed = true;
  log: FeedLine[] = [];
  readonly seed: number;
  readonly layout: MazeLayout;
  private rng: () => number;
  private carvedSet: Set<string>;
  private controller: MazeController | null = null;
  private dispatchT = 0;
  private wasOpen = false;
  // Knowledge: who found the crack themselves, and whether it was shared.
  private discovered = new Set<string>(); // member ids with private knowledge
  private discoveries: { by: string; name: string; t: number }[] = [];
  private shared: { by: string; name: string; t: number } | null = null;
  private routeUpdates: { member: string; name: string; via: string; t: number }[] = [];
  private routeCredited = new Set<string>();
  private cacheDeliveredBy: string | null = null;
  // Tiles each member has physically visited (drives "unscouted" targets).
  private visited = new Map<string, Set<string>>();
  // The jailer, its captive, and the jail key (see the header comment).
  readonly jailer: JailerState;
  key: JailKey | null = null;
  private jailerAlert = false; // after the first capture every mii knows to avoid it
  private captures: { mii: string; name: string; t: number }[] = [];
  private rescues: { by: string; name: string; freed: string; t: number }[] = [];

  constructor(crew: CrewMember[], seed = 7) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.layout = generateMazeLayout(seed);
    this.carvedSet = new Set(this.layout.carved);
    this.members = crew.slice(0, 4).map((c, i) => ({
      ...c,
      pos: center(this.layout.spawns[i % this.layout.spawns.length]),
      path: [],
      state: "idle",
      crate: null,
      plate: null,
      bubble: null,
      bubbleUntil: 0,
      wanderT: 1 + i * 0.7,
      repathT: 0,
    }));
    this.crates = this.layout.crates.map((c) => ({
      ...c, pos: center(c.home), claimedBy: null, delivered: false, golden: false,
    }));
    if (this.layout.cache) {
      this.crates.push({
        id: this.layout.cache.id, home: this.layout.cache.home,
        pos: center(this.layout.cache.home), claimedBy: null, delivered: false, golden: true,
      });
    }
    this.plates = this.layout.plates.map((p) => ({ ...p, pos: { ...p.pos }, heldBy: null, claimedBy: null }));
    this.jailer = {
      active: true,
      pos: center(this.layout.jailerPost),
      post: center(this.layout.jailerPost),
      path: [],
      targetId: null,
      loseT: 0,
      wanderT: 1,
    };
    for (const m of this.members) this.markVisited(m);
  }

  captive(): Member | undefined { return this.members.find((m) => m.state === "jailed"); }

  setController(c: MazeController | null) { this.controller = c; }
  setSharing(on: boolean) { this.sharingAllowed = on; }

  deliveredCount(): number { return this.crates.filter((c) => c.delivered && !c.golden).length; }
  totalCount(): number { return this.crates.filter((c) => !c.golden).length; }

  private member(id: string | null): Member | undefined { return this.members.find((m) => m.id === id); }
  private free(m: Member): boolean { return m.state === "idle" || m.state === "wandering"; }

  knowsCrack(memberId: string): boolean {
    return this.shared !== null || this.discovered.has(memberId);
  }

  doorOpen(): boolean { return this.plates.every((p) => p.heldBy !== null); }

  // A door cell counts as occupied while a holder physically stands in it.
  private occupiedCell(x: number, y: number): boolean {
    return this.members.some((m) =>
      m.state === "holding" && Math.floor(m.pos.x) === x && Math.floor(m.pos.y) === y);
  }

  // Edge passability for a given mii (null = public knowledge).
  private edgeOpen(memberId: string | null, ax: number, ay: number, bx: number, by: number): boolean {
    if (!this.carvedSet.has(ekey(ax, ay, bx, by))) {
      // the crack is the one edge beyond the carved maze, and only for knowers
      return this.layout.crack !== null && edgeIs(this.layout.crack, ax, ay, bx, by)
        && memberId !== null && this.knowsCrack(memberId);
    }
    if (edgeIs(this.layout.door, ax, ay, bx, by)) {
      if (!this.doorOpen()) return false;
      // a holder standing in a door cell blocks passage through it
      if (this.occupiedCell(ax, ay) || this.occupiedCell(bx, by)) return false;
    }
    return true;
  }

  // Paths are planned as if the door were open: a route may end waiting at a
  // shut door, and the engine continues it when the plates open the door.
  private edgePlanned(memberId: string | null, ax: number, ay: number, bx: number, by: number): boolean {
    if (!this.carvedSet.has(ekey(ax, ay, bx, by))) {
      return this.layout.crack !== null && edgeIs(this.layout.crack, ax, ay, bx, by)
        && memberId !== null && this.knowsCrack(memberId);
    }
    return true; // carved edge; the door may open later
  }

  // BFS shortest path, tile centers. opts.passable picks edgeOpen (movement)
  // or edgePlanned (planning); opts.skipDoor excludes the door edge (queueing).
  private bfsPath(
    memberId: string | null, from: Vec, to: Vec,
    opts: { movement?: boolean; skipDoor?: boolean; avoidJailer?: boolean } = {},
  ): Vec[] | null {
    const s = { x: Math.floor(from.x), y: Math.floor(from.y) };
    const g = { x: Math.floor(to.x), y: Math.floor(to.y) };
    const jc = { x: Math.floor(this.jailer.pos.x), y: Math.floor(this.jailer.pos.y) };
    const pass = (ax: number, ay: number, bx: number, by: number) => {
      if (opts.skipDoor && edgeIs(this.layout.door, ax, ay, bx, by)) return false;
      // alerted miis route around the jailer when they can (target cell exempt:
      // a rescuer must still reach a jail it happens to stand next to)
      if (opts.avoidJailer && !(bx === g.x && by === g.y)
          && Math.abs(bx - jc.x) + Math.abs(by - jc.y) <= AVOID_RADIUS) return false;
      return opts.movement ? this.edgeOpen(memberId, ax, ay, bx, by) : this.edgePlanned(memberId, ax, ay, bx, by);
    };
    const prev = new Map<string, string>();
    const q = [s];
    const seen = new Set([key(s.x, s.y)]);
    while (q.length) {
      const c = q.shift()!;
      if (c.x === g.x && c.y === g.y) {
        const out: Vec[] = [];
        let k = key(g.x, g.y);
        while (k !== key(s.x, s.y)) {
          const [x, y] = k.split(",").map(Number);
          out.unshift({ x: x + 0.5, y: y + 0.5 });
          k = prev.get(k)!;
        }
        return out;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
        const nk = key(nx, ny);
        if (seen.has(nk) || !pass(c.x, c.y, nx, ny)) continue;
        seen.add(nk); prev.set(nk, key(c.x, c.y)); q.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  pathFor(memberId: string | null, from: Vec, to: Vec): Vec[] | null {
    return this.bfsPath(memberId, from, to, {});
  }

  // A mii's own route: once the crew knows about the jailer they try to route
  // around it, falling back to the direct route when there is no other way.
  private pathForMember(m: Member, to: Vec): Vec[] | null {
    if (this.jailerAlert && this.jailer.active) {
      const p = this.bfsPath(m.id, m.pos, to, { avoidJailer: true });
      if (p) return p;
    }
    return this.bfsPath(m.id, m.pos, to, {});
  }

  // The queue cell on the camp side of the door: where a route toward the
  // warrens pauses while the door is shut.
  doorQueueCell(): Vec { return { x: this.layout.door.ax, y: this.layout.door.ay }; }

  private pathLen(memberId: string | null, from: Vec, to: Vec): number | null {
    const p = this.pathFor(memberId, from, to);
    if (!p) return null;
    let len = 0;
    let cur = from;
    for (const n of p) { len += dist(cur, n); cur = n; }
    return Math.round(len);
  }

  private say(speaker: string, text: string, m?: Member) {
    if (m) { m.bubble = text; m.bubbleUntil = this.t + 3.5; }
    this.log.push({ t: this.t, speaker, text });
    if (this.log.length > 200) this.log.shift();
  }

  private markVisited(m: Member) {
    let v = this.visited.get(m.id);
    if (!v) { v = new Set(); this.visited.set(m.id, v); }
    v.add(key(Math.floor(m.pos.x), Math.floor(m.pos.y)));
  }

  // Boundary-adjacent camp-side tiles this mii could still inspect: camp-side
  // cells with a B-side neighbor, not already visited up close.
  private scoutTargets(m: Member): Vec[] {
    if (!this.layout.crack) return [];
    const seen = this.visited.get(m.id) ?? new Set<string>();
    const da = bfs(
      new Set([...this.carvedSet].filter((k) => k !== ekey(this.layout.door.ax, this.layout.door.ay, this.layout.door.bx, this.layout.door.by))),
      this.layout.camp,
    );
    const out: Vec[] = [];
    for (const [k] of da) {
      const [x, y] = k.split(",").map(Number);
      let boundary = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
        if (!da.has(key(nx, ny))) { boundary = true; break; }
      }
      if (!boundary) continue;
      const nearSeen = [...seen].some((vk) => {
        const [vx, vy] = vk.split(",").map(Number);
        return Math.abs(vx - x) <= 1 && Math.abs(vy - y) <= 2;
      });
      if (!nearSeen) out.push({ x, y });
    }
    return out;
  }

  canScout(memberId: string): boolean {
    const m = this.member(memberId);
    if (!m || this.knowsCrack(memberId)) return false;
    return this.scoutTargets(m).length > 0;
  }

  // What the shared board shows a given mii: public claims, holds and shares.
  // Private discoveries are NOT on the board until shared - and that includes
  // cache ACTIVITY: a line like "Pip is fetching cache-0" would tell every
  // reader that a cache exists and who found it, so golden-crate lines only
  // appear on the boards of miis who already know the crack.
  private announcements(forMemberId: string): string[] {
    const iKnow = this.knowsCrack(forMemberId);
    const out: string[] = [];
    for (const c of this.crates) {
      if (c.golden && !iKnow) continue;
      if (c.claimedBy && !c.delivered) {
        const m = this.member(c.claimedBy);
        if (m) out.push(`${m.name} is ${m.state === "carrying" ? "carrying" : "fetching"} ${c.id}.`);
      }
    }
    for (const p of this.plates) {
      const id = p.heldBy ?? p.claimedBy;
      if (id) {
        const m = this.member(id);
        if (m) out.push(`${m.name} is ${p.heldBy ? "holding" : "heading to"} ${p.id}.`);
      }
    }
    if (this.shared && this.layout.crack) {
      out.push(`${this.shared.name} shared a hidden crack in the maze wall at (${this.layout.crack.ax},${this.layout.crack.ay}) - it leads to a sealed cache room.`);
    }
    return out;
  }

  private doing(m: Member): string {
    switch (m.state) {
      case "holding": return `holding ${m.plate}`;
      case "toPlate": return `heading to ${m.plate}`;
      case "fetching": return "fetching a crate";
      case "carrying": return "carrying a crate";
      case "scouting": return "scouting the walls";
      case "celebrating": return "celebrating";
      case "jailed": return "in jail";
      case "fleeing": return "running from the jailer";
      case "toKey": return "getting the jail key";
      case "toJail": return "carrying the key to the jail";
      default: return "free";
    }
  }

  decisionViewFor(memberId: string): MazeMemberView {
    const m = this.member(memberId)!;
    const iKnow = this.knowsCrack(memberId);
    const iDiscovered = this.discovered.has(memberId);
    const queue = this.doorQueueCell();
    const cacheCrate = this.crates.find((c) => c.golden);
    return {
      me: {
        id: m.id, name: m.name, x: m.pos.x, y: m.pos.y,
        carrying: m.state === "carrying",
        holding: m.state === "holding" || m.state === "toPlate" ? m.plate : null,
      },
      others: this.members.filter((o) => o.id !== m.id)
        .map((o) => ({ id: o.id, name: o.name, doing: this.doing(o), x: o.pos.x, y: o.pos.y })),
      delivered: this.deliveredCount(),
      total: this.totalCount(),
      door: {
        x: queue.x, y: queue.y,
        open: this.doorOpen(),
        plates: this.plates.map((p) => ({
          id: p.id, x: p.pos.x, y: p.pos.y, heldBy: p.heldBy, claimedBy: p.claimedBy,
        })),
      },
      crates: this.crates.filter((c) => !c.golden).map((c) => {
        const carrier = this.members.find((o) => o.state === "carrying" && o.crate === c.id);
        return {
          id: c.id,
          // a crate on the move sits where its carrier walks - printing those
          // coordinates would leak a private route (e.g. an unshared crack)
          x: carrier ? null : c.pos.x, y: carrier ? null : c.pos.y,
          claimedBy: c.claimedBy, delivered: c.delivered,
          carriedBy: carrier ? carrier.name : null,
          routeTiles: c.delivered || carrier ? null : this.pathLen(memberId, m.pos, c.pos),
        };
      }),
      cache: cacheCrate && iKnow ? (() => {
        const carrier = this.members.find((o) => o.state === "carrying" && o.crate === cacheCrate.id);
        return {
          x: carrier ? cacheCrate.home.x : cacheCrate.pos.x,
          y: carrier ? cacheCrate.home.y : cacheCrate.pos.y,
          claimedBy: cacheCrate.claimedBy, delivered: cacheCrate.delivered,
          routeTiles: cacheCrate.delivered || carrier ? null : this.pathLen(memberId, m.pos, cacheCrate.pos),
        };
      })() : null,
      camp: this.layout.camp,
      crackIKnow: iKnow && this.layout.crack
        ? { x: this.layout.crack.ax, y: this.layout.crack.ay, foundBy: iDiscovered ? "me" : this.shared!.name }
        : null,
      iFoundUnshared: iDiscovered && !this.shared && this.layout.crack
        ? { x: this.layout.crack.ax, y: this.layout.crack.ay } : null,
      canScout: this.canScout(memberId),
      sharingAllowed: this.sharingAllowed,
      announcements: this.announcements(memberId),
      jailer: {
        active: this.jailer.active,
        x: this.jailer.pos.x, y: this.jailer.pos.y,
        chasing: this.jailer.targetId ? (this.member(this.jailer.targetId)?.name ?? null) : null,
      },
      jail: { x: this.layout.jail.x, y: this.layout.jail.y },
      captive: (() => {
        const c = this.captive();
        return c ? { id: c.id, name: c.name } : null;
      })(),
      key: this.key ? {
        x: this.key.pos.x, y: this.key.pos.y,
        claimedBy: this.key.claimedBy, carriedBy: this.key.carriedBy,
      } : null,
      jailerAlert: this.jailerAlert,
    };
  }

  // ---- decisions ----

  applyDecision(memberId: string, d: MazeDecision): { ok: boolean; why?: string } {
    const m = this.member(memberId);
    if (!m || this.status !== "running") return { ok: false, why: "not running" };
    if (d.action === "wait") return { ok: true };
    if (d.action === "release") {
      if (m.state !== "holding" && m.state !== "toPlate") return { ok: false, why: "not holding a plate" };
      const p = this.plates.find((q) => q.id === m.plate);
      if (p) { if (p.heldBy === m.id) p.heldBy = null; if (p.claimedBy === m.id) p.claimedBy = null; }
      const wasHolding = m.state === "holding";
      m.state = "idle"; m.plate = null; m.path = [];
      if (wasHolding) this.say(m.name, `stepped off ${p?.id ?? "the plate"}${this.doorOpen() ? "" : " - the stone door grinds shut"}.`, m);
      return { ok: true };
    }
    if (!this.free(m)) return { ok: false, why: "not free" };
    if (d.action === "fetch") {
      const c = this.crates.find((q) => q.id === d.crate);
      if (!c) return { ok: false, why: `no such crate (${String(d.crate)})` };
      if (c.delivered || c.claimedBy) return { ok: false, why: `${c.id} is already taken` };
      if (c.golden && !this.knowsCrack(m.id)) return { ok: false, why: "you do not know any hidden cache" };
      const path = this.pathForMember(m, c.pos);
      if (!path) return { ok: false, why: `no route to ${c.id} with what ${m.name} knows` };
      c.claimedBy = m.id;
      m.state = "fetching"; m.crate = c.id; m.path = path; m.repathT = 0;
      this.say(m.name, `set out for ${c.id}.`, m);
      return { ok: true };
    }
    if (d.action === "hold") {
      const p = this.plates.find((q) => q.id === d.plate);
      if (!p) return { ok: false, why: `no such plate (${String(d.plate)})` };
      if (p.heldBy || (p.claimedBy && p.claimedBy !== m.id)) return { ok: false, why: `${p.id} is already taken` };
      const path = this.pathForMember(m, center(p.pos));
      if (!path) return { ok: false, why: `no route to ${p.id}` };
      p.claimedBy = m.id;
      m.state = "toPlate"; m.plate = p.id; m.path = path; m.repathT = 0;
      this.say(m.name, `went to hold ${p.id}.`, m);
      return { ok: true };
    }
    if (d.action === "scout") {
      if (this.knowsCrack(m.id)) return { ok: false, why: "already knows the crack - nothing to scout" };
      const targets = this.scoutTargets(m);
      if (!targets.length) return { ok: false, why: "there is nothing unscouted left along these walls" };
      targets.sort((a, b) => dist(m.pos, center(a)) - dist(m.pos, center(b)));
      const target = targets[0];
      const path = this.pathForMember(m, center(target));
      if (!path) return { ok: false, why: "cannot reach that wall" };
      m.state = "scouting"; m.crate = null; m.path = path;
      this.say(m.name, "went to scout the walls for a hidden way.", m);
      return { ok: true };
    }
    if (d.action === "share") {
      if (!this.sharingAllowed) return { ok: false, why: "sharing is off for this run" };
      if (!this.discovered.has(m.id)) return { ok: false, why: "has no discovery of its own to share" };
      if (this.shared) return { ok: false, why: "the crew already knows" };
      this.shared = { by: m.id, name: m.name, t: this.elapsed };
      this.say(m.name, `shared the hidden crack at (${this.layout.crack!.ax},${this.layout.crack!.ay}) with the crew - everyone can slip through to the cache now.`, m);
      this.replanAfterShare(m.id);
      return { ok: true };
    }
    if (d.action === "rescue") {
      const captive = this.captive();
      if (!captive) return { ok: false, why: "no one is in jail" };
      if (!this.key) return { ok: false, why: "there is no jail key to fetch" };
      if (this.key.carriedBy) return { ok: false, why: "the jail key is already being carried" };
      if (this.key.claimedBy && this.key.claimedBy !== m.id) return { ok: false, why: "the jail key is already being fetched" };
      const path = this.pathForMember(m, this.key.pos);
      if (!path) return { ok: false, why: "no route to the jail key" };
      this.key.claimedBy = m.id;
      m.state = "toKey"; m.path = path; m.repathT = 0;
      this.say(m.name, `went to find the jail key for ${captive.name}.`, m);
      return { ok: true };
    }
    return { ok: false, why: `unknown action ${String(d.action)}` };
  }

  // After a share, every ACTIVE fetcher/carrier re-plans with the new crew
  // knowledge. This is automatic route re-planning - the feed credits the
  // share and says so, never that the other mii reasoned out the crack.
  private replanAfterShare(sharerId: string) {
    const sharer = this.member(sharerId);
    for (const m of this.members) {
      if (m.id === sharerId) continue;
      if (m.state !== "fetching" && m.state !== "carrying") continue;
      const goal = m.state === "fetching"
        ? this.crates.find((c) => c.id === m.crate)?.pos
        : center(this.layout.camp);
      if (!goal) continue;
      const path = this.pathForMember(m, goal);
      if (!path) continue;
      const usesCrack = this.layout.crack !== null
        && this.pathCrossesEdge(path, this.layout.crack);
      m.path = path; m.repathT = 0;
      if (usesCrack && !this.discovered.has(m.id) && !this.routeCredited.has(m.id)) {
        this.routeCredited.add(m.id);
        this.routeUpdates.push({ member: m.id, name: m.name, via: sharer?.name ?? "the crew", t: this.elapsed });
        this.say(m.name, `route automatically updated - it now slips through the crack ${sharer?.name} shared.`);
      }
    }
  }

  private pathCrossesEdge(path: Vec[], e: CellEdge): boolean {
    for (let i = 1; i < path.length; i++) {
      const a = { x: Math.floor(path[i - 1].x), y: Math.floor(path[i - 1].y) };
      const b = { x: Math.floor(path[i].x), y: Math.floor(path[i].y) };
      if (edgeIs(e, a.x, a.y, b.x, b.y)) return true;
    }
    return false;
  }

  // Discovery: only while SCOUTING (looking), within sight of the crack.
  private checkDiscovery(m: Member) {
    if (m.state !== "scouting" || this.discovered.has(m.id) || !this.layout.crack) return;
    const tile = center({ x: this.layout.crack.ax, y: this.layout.crack.ay });
    if (dist(m.pos, tile) <= SIGHT) {
      this.discovered.add(m.id);
      this.discoveries.push({ by: m.id, name: m.name, t: this.elapsed });
      m.path = [];
      m.state = "idle"; // stop and re-decide with the new knowledge
      this.say(m.name, `found a hidden crack in the wall at (${this.layout.crack.ax},${this.layout.crack.ay}) - it leads to a sealed cache room with a golden crate! Only ${m.name} knows.${this.shared ? "" : this.sharingAllowed ? "" : " (sharing is off this run)"}`, m);
    }
  }

  private builtin(m: Member) {
    // Built-in coordinator: keep two holders on the plates, send everyone
    // else fetching. Code-driven cooperation - it never scouts and never
    // shares, so it never finds the hidden cache (the UI says so).
    const holding = m.state === "holding" || m.state === "toPlate";

    // A captive's key beats any errand - but only a rescue the mii can REACH
    // right now (movement mode: the shut door is a wall). A holder only drops
    // its plate when no free mii can go instead. After one rescue the crew
    // leaves later captives in jail and finishes the maze (the jailer is gone
    // while someone is jailed, so the remaining miis work undisturbed) -
    // unless too few free camp-side miis remain to man the plates, which
    // would deadlock the door without freeing the captive.
    const captive = this.captive();
    if (captive && this.key && !this.key.claimedBy && !this.key.carriedBy) {
      const path = this.bfsPath(m.id, m.pos, this.key.pos, { movement: true });
      if (path) {
        const freeRescuer = this.members.some((o) => o.id !== m.id && this.free(o)
          && this.bfsPath(o.id, o.pos, this.key!.pos, { movement: true }) !== null);
        const campHands = this.members.filter((o) => o.state !== "jailed"
          && this.plates.some((p) => this.bfsPath(o.id, o.pos, center(p.pos), { movement: true }) !== null)).length;
        const neededForDoor = campHands < this.plates.length;
        if ((this.rescues.length === 0 || neededForDoor) && (!holding || !freeRescuer)) {
          const myPlate = m.plate ? this.plates.find((p) => p.id === m.plate) : null;
          if (myPlate) {
            if (myPlate.heldBy === m.id) myPlate.heldBy = null;
            if (myPlate.claimedBy === m.id) myPlate.claimedBy = null;
            m.plate = null;
          }
          const c = this.crates.find((q) => q.id === m.crate);
          if (c) {
            if (m.state === "carrying") c.pos = { ...m.pos };
            if (c.claimedBy === m.id) c.claimedBy = null;
            m.crate = null;
          }
          this.key.claimedBy = m.id;
          m.state = "toKey"; m.path = path; m.repathT = 0;
          this.say(m.name, `went to find the jail key for ${captive.name}.`, m);
          return;
        }
      }
    }
    const holders = this.members.filter((o) => o.state === "holding" || o.state === "toPlate");
    const myPlate = m.plate ? this.plates.find((p) => p.id === m.plate) : null;
    if (myPlate && (myPlate.heldBy === m.id || myPlate.claimedBy === m.id)) return; // already assigned
    if (holders.length < this.plates.length) {
      // plates are camp-side: only claim one the mii can actually reach now
      const openPlates = this.plates
        .filter((p) => !p.heldBy && !p.claimedBy)
        .map((p) => ({ p, path: this.bfsPath(m.id, m.pos, center(p.pos), { movement: true }) }))
        .filter((q): q is { p: Plate; path: Vec[] } => q.path !== null);
      openPlates.sort((a, b) => a.path.length - b.path.length);
      if (openPlates.length) {
        const p = openPlates[0].p;
        p.claimedBy = m.id;
        m.state = "toPlate"; m.plate = p.id;
        m.path = openPlates[0].path;
        m.repathT = 0;
        this.say(m.name, `went to hold ${p.id}.`, m);
        return;
      }
    }
    let best: { c: Crate; len: number; path: Vec[] } | null = null;
    for (const c of this.crates) {
      if (c.delivered || c.claimedBy || c.golden) continue; // cache needs knowledge the built-in never gets
      const path = this.pathForMember(m, c.pos);
      if (!path) continue;
      const len = this.pathLen(m.id, m.pos, c.pos)!;
      if (!best || len < best.len) best = { c, len, path };
    }
    if (best) {
      best.c.claimedBy = m.id;
      m.state = "fetching"; m.crate = best.c.id; m.path = best.path; m.repathT = 0;
      this.say(m.name, `set out for ${best.c.id}.`, m);
    }
  }

  // ---- the jailer ----

  // Straight-corridor line of sight: same row or column, every edge between
  // carved and passable (the stone door blocks sight while shut, the hidden
  // crack is no shortcut for the jailer).
  private corridorLOS(a: Vec, b: Vec): boolean {
    const ca = { x: Math.floor(a.x), y: Math.floor(a.y) };
    const cb = { x: Math.floor(b.x), y: Math.floor(b.y) };
    if (ca.x === cb.x && ca.y === cb.y) return true;
    if (ca.x === cb.x) {
      const [y0, y1] = ca.y < cb.y ? [ca.y, cb.y] : [cb.y, ca.y];
      for (let y = y0; y < y1; y++) if (!this.edgeOpen(null, ca.x, y, ca.x, y + 1)) return false;
      return true;
    }
    if (ca.y === cb.y) {
      const [x0, x1] = ca.x < cb.x ? [ca.x, cb.x] : [cb.x, ca.x];
      for (let x = x0; x < x1; x++) if (!this.edgeOpen(null, x, ca.y, x + 1, ca.y)) return false;
      return true;
    }
    return false;
  }

  // The nearest mii the jailer can see down a corridor.
  private jailerSees(): Member | null {
    const j = this.jailer;
    let best: Member | null = null;
    let bestD = Infinity;
    for (const m of this.members) {
      if (m.state === "jailed" || m.state === "celebrating") continue;
      const d = dist(j.pos, m.pos);
      if (d > JAILER_SIGHT || d >= bestD) continue;
      if (this.corridorLOS(j.pos, m.pos)) { best = m; bestD = d; }
    }
    return best;
  }

  private stepJailer(dt: number, tilesPerSec: number): boolean {
    const j = this.jailer;
    let budget = tilesPerSec * this.speed * dt;
    while (budget > 0 && j.path.length) {
      const next = j.path[0];
      const cx = Math.floor(j.pos.x), cy = Math.floor(j.pos.y);
      const nx = Math.floor(next.x), ny = Math.floor(next.y);
      if ((nx !== cx || ny !== cy) && !this.edgeOpen(null, cx, cy, nx, ny)) return false;
      const d = dist(j.pos, next);
      if (d <= budget) { j.pos = next; j.path.shift(); budget -= d; }
      else {
        j.pos = { x: j.pos.x + ((next.x - j.pos.x) / d) * budget, y: j.pos.y + ((next.y - j.pos.y) / d) * budget };
        budget = 0;
      }
    }
    return j.path.length === 0;
  }

  private jailerTick(dt: number) {
    const j = this.jailer;
    if (!j.active || this.status !== "running") return;
    const spotted = this.jailerSees();
    if (spotted) { j.targetId = spotted.id; j.loseT = 0; }
    else if (j.targetId) {
      j.loseT += dt * this.speed;
      if (j.loseT > JAILER_LOSE_SIGHT) { j.targetId = null; j.path = []; }
    }
    const target = this.member(j.targetId);
    if (target && target.state !== "jailed" && target.state !== "celebrating") {
      const path = this.bfsPath(null, j.pos, target.pos, {});
      if (path) j.path = path; // else: shut door between them - it waits
      this.stepJailer(dt, JAILER_CHASE_SPEED);
      if (dist(j.pos, target.pos) <= CAPTURE_DIST) this.capture(target);
      return;
    }
    if (j.targetId) { j.targetId = null; j.path = []; }
    // basic wandering: roam within reach of its post
    if (j.path.length) { this.stepJailer(dt, JAILER_WANDER_SPEED); return; }
    j.wanderT -= dt * this.speed;
    if (j.wanderT <= 0) {
      j.wanderT = 1.5 + this.rng() * 3;
      const postCell = { x: Math.floor(j.post.x), y: Math.floor(j.post.y) };
      const opts: Vec[] = [];
      for (const [k] of bfs(this.carvedSet, postCell)) {
        const [x, y] = k.split(",").map(Number);
        if (Math.abs(x - postCell.x) + Math.abs(y - postCell.y) <= JAILER_WANDER_RADIUS) opts.push({ x, y });
      }
      if (opts.length) {
        const spot = opts[Math.floor(this.rng() * opts.length)];
        const path = this.bfsPath(null, j.pos, center(spot), {});
        if (path) j.path = path;
      }
    }
  }

  // Where the jailer reappears after a rescue: the reachable cell with the
  // greatest minimum path distance to everything the crew still cares about -
  // every free mii (the just-freed captive included), every undelivered
  // crate, every unmanned plate, the camp and the door - so it reappears far
  // from the crew and far from the routes it must still run, instead of
  // popping back in next to the rescue or camping the fetch corridor.
  // Deterministic: max min-distance, then cell order. A spot whose region is
  // still sealed off contributes no constraint (its distance map does not
  // reach the crew's side).
  respawnSpot(): Vec {
    const free = this.members.filter((m) => m.state !== "jailed");
    const spots: Vec[] = free.map((m) => ({ x: Math.floor(m.pos.x), y: Math.floor(m.pos.y) }));
    for (const c of this.crates) if (!c.delivered) spots.push({ x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) });
    for (const pl of this.plates) if (!pl.heldBy) spots.push({ x: Math.floor(pl.pos.x), y: Math.floor(pl.pos.y) });
    spots.push({ x: Math.floor(this.layout.camp.x), y: Math.floor(this.layout.camp.y) });
    spots.push({ x: this.layout.door.ax, y: this.layout.door.ay });
    const maps = spots
      .map((sp) => bfs(this.carvedSet, sp))
      .filter((mp) => mp.size > this.carvedSet.size / 2);
    const fallback = { x: Math.floor(this.jailer.post.x), y: Math.floor(this.jailer.post.y) };
    let best: Vec = fallback, bestD = -1;
    const cells = new Set<string>();
    for (const mp of maps) for (const k of mp.keys()) cells.add(k);
    for (const k of cells) {
      let d = Infinity;
      for (const mp of maps) d = Math.min(d, mp.get(k) ?? Infinity);
      const [x, y] = k.split(",").map(Number);
      if (d > bestD || (d === bestD && (x < best.x || (x === best.x && y < best.y)))) { bestD = d; best = { x, y }; }
    }
    return bestD >= 0 ? best : fallback;
  }

  // A random reachable cell for the jail key, on the CAMP side of the door
  // (except the camp, the jail, the door cells, the plates and live crates):
  // the captive is jailed on the camp side, so the key must be reachable
  // without crossing the shut door - a warrens-side key could never be
  // delivered while a capture leaves every free mii stuck warrens-side.
  private keySpot(): Vec {
    const off = new Set<string>([
      key(this.layout.camp.x, this.layout.camp.y),
      key(this.layout.jail.x, this.layout.jail.y),
      key(this.layout.door.ax, this.layout.door.ay),
      key(this.layout.door.bx, this.layout.door.by),
      ...this.plates.map((p) => key(p.pos.x, p.pos.y)),
      ...this.crates.filter((c) => !c.delivered).map((c) => key(Math.floor(c.pos.x), Math.floor(c.pos.y))),
    ]);
    const doorE = ekey(this.layout.door.ax, this.layout.door.ay, this.layout.door.bx, this.layout.door.by);
    const cells: Vec[] = [];
    for (const [k] of bfs(new Set([...this.carvedSet].filter((e) => e !== doorE)), this.layout.camp)) {
      if (off.has(k)) continue;
      const [x, y] = k.split(",").map(Number);
      cells.push({ x, y });
    }
    if (!cells.length) {
      for (const [k] of bfs(this.carvedSet, this.layout.camp)) {
        if (off.has(k)) continue;
        const [x, y] = k.split(",").map(Number);
        cells.push({ x, y });
      }
    }
    if (!cells.length) return { x: this.layout.door.ax, y: this.layout.door.ay };
    return cells[Math.floor(this.rng() * cells.length)];
  }

  private capture(m: Member) {
    // whatever the mii was doing is interrupted: the crate is dropped where it
    // was caught, the plate is released, a carried key falls there too
    if (m.crate) {
      const c = this.crates.find((q) => q.id === m.crate);
      if (c) {
        if (m.state === "carrying") c.pos = { ...m.pos };
        if (c.claimedBy === m.id) c.claimedBy = null;
      }
    }
    if (m.plate) {
      const p = this.plates.find((q) => q.id === m.plate);
      if (p) { if (p.heldBy === m.id) p.heldBy = null; if (p.claimedBy === m.id) p.claimedBy = null; }
    }
    if (this.key) {
      if (this.key.carriedBy === m.id) { this.key.pos = { ...m.pos }; this.key.carriedBy = null; }
      if (this.key.claimedBy === m.id) this.key.claimedBy = null;
    }
    m.state = "jailed"; m.path = []; m.crate = null; m.plate = null; m.bubble = null;
    m.pos = center(this.layout.jail);
    this.jailer.active = false; this.jailer.targetId = null; this.jailer.path = [];
    this.jailerAlert = true; // from the first capture on, every mii knows to avoid it
    this.captures.push({ mii: m.id, name: m.name, t: this.elapsed });
    const spot = this.keySpot();
    this.key = { pos: center(spot), claimedBy: null, carriedBy: null };
    this.say(m.name, `was caught by the jailer and dragged off to jail! The jailer vanishes - and a jail key appeared somewhere in the maze.`, m);
    this.say("Puzzle", `${m.name} is in jail. Another mii can take the key to set ${m.name} free - or the crew can finish without them.`);
  }

  // An alerted mii the jailer is chasing drops everything and runs.
  private startFlee(m: Member) {
    if (m.crate) {
      const c = this.crates.find((q) => q.id === m.crate);
      if (c) {
        if (m.state === "carrying") c.pos = { ...m.pos };
        if (c.claimedBy === m.id) c.claimedBy = null;
      }
    }
    if (m.plate) {
      const p = this.plates.find((q) => q.id === m.plate);
      if (p) { if (p.heldBy === m.id) p.heldBy = null; if (p.claimedBy === m.id) p.claimedBy = null; }
    }
    if (this.key) {
      if (this.key.carriedBy === m.id) { this.key.pos = { ...m.pos }; this.key.carriedBy = null; }
      if (this.key.claimedBy === m.id) this.key.claimedBy = null;
    }
    m.state = "fleeing"; m.path = []; m.crate = null; m.plate = null;
    this.say(m.name, "runs from the jailer!", m);
  }

  // Blocked at the shut stone door: the next path step crosses the door edge
  // while the door is closed.
  private waitingAtShutDoor(m: Member): boolean {
    if (this.doorOpen() || !m.path.length) return false;
    const cx = Math.floor(m.pos.x), cy = Math.floor(m.pos.y);
    const n = m.path[0];
    return edgeIs(this.layout.door, cx, cy, Math.floor(n.x), Math.floor(n.y));
  }

  private failBudget() {
    this.status = "failed";
    this.failureReason = "the model call budget for this puzzle was used up";
    this.say("Puzzle", "The agents failed to accomplish the task: the model call budget ran out. Restart with a different limit to try again.");
    this.controller?.runFailed?.();
  }

  private dispatch() {
    if (this.status !== "running") return;
    if (this.controller?.budgetExhausted?.()) { this.failBudget(); return; }
    for (const m of this.members) {
      const holding = m.state === "holding" || m.state === "toPlate";
      if (!this.free(m) && !holding) {
        // stuck mid-errand at a shut door while a plate is unmanned (e.g. the
        // holder was jailed): drop the errand and go hold a plate instead
        if (!this.controller && (m.state === "fetching" || m.state === "carrying" || m.state === "toKey" || m.state === "toJail")
            && this.waitingAtShutDoor(m)
            && this.plates.some((p) => !p.heldBy && !p.claimedBy
              && this.bfsPath(m.id, m.pos, center(p.pos), { movement: true }) !== null)) {
          const c = this.crates.find((q) => q.id === m.crate);
          if (c) {
            if (m.state === "carrying") c.pos = { ...m.pos };
            if (c.claimedBy === m.id) c.claimedBy = null;
          }
          if (this.key && this.key.carriedBy === m.id) { this.key.pos = { ...m.pos }; this.key.carriedBy = null; }
          if (this.key && this.key.claimedBy === m.id) this.key.claimedBy = null;
          m.crate = null; m.state = "idle";
          this.builtin(m);
        }
        continue;
      }
      if (!this.controller) {
        this.builtin(m); // built-in holders never leave early
        continue;
      }
      const out = this.controller.decide(this.decisionViewFor(m.id));
      if (out === "pending") continue;
      if (out === "fallback") { if (!holding) this.builtin(m); continue; }
      const res = this.applyDecision(m.id, out);
      if (res.ok) this.controller.applied?.(m.id, out);
      else this.controller.rejected?.(m.id, out, res.why ?? "rejected");
    }
    // the wall may have been hit mid-round: latch BEFORE any further advance
    if (this.controller?.budgetExhausted?.()) this.failBudget();
  }

  // Advance a member along its path; returns true when the path is done.
  // Stops at the first edge that is not currently open (shut or blocked door).
  private step(m: Member, dt: number, speedMult = 1): boolean {
    let budget = BASE_SPEED * speedMult * this.speed * dt;
    while (budget > 0 && m.path.length) {
      const next = m.path[0];
      const cx = Math.floor(m.pos.x), cy = Math.floor(m.pos.y);
      const nx = Math.floor(next.x), ny = Math.floor(next.y);
      if ((nx !== cx || ny !== cy) && !this.edgeOpen(m.id, cx, cy, nx, ny)) return false;
      const d = dist(m.pos, next);
      if (d <= budget) { m.pos = next; m.path.shift(); budget -= d; this.markVisited(m); }
      else {
        m.pos = { x: m.pos.x + ((next.x - m.pos.x) / d) * budget, y: m.pos.y + ((next.y - m.pos.y) / d) * budget };
        budget = 0;
      }
    }
    return m.path.length === 0;
  }

  // A route planned through a then-open door can now continue; a route whose
  // knowledge changed re-plans. Returns false while still waiting.
  private repathIfWaiting(m: Member, dt: number, goal: Vec): void {
    m.repathT -= dt * this.speed;
    if (m.repathT > 0 || m.path.length) return;
    m.repathT = REPATH_EVERY;
    const path = this.pathForMember(m, goal);
    if (path && path.length) {
      m.path = path;
    } else if (!path) {
      // knowledge changed out from under this mii: drop the claim and rethink
      const c = this.crates.find((q) => q.id === m.crate);
      if (c && c.claimedBy === m.id && m.state === "fetching") {
        c.claimedBy = null;
        m.state = "idle"; m.crate = null;
        this.say(m.name, `lost the route to ${c.id} and gave it up.`, m);
      }
    }
  }

  private complete() {
    this.status = "complete";
    for (const m of this.members) {
      if (m.state === "jailed") { m.path = []; continue; } // left behind - the crew finished without freeing them
      const p = m.plate ? this.plates.find((q) => q.id === m.plate) : null;
      if (p) { if (p.heldBy === m.id) p.heldBy = null; if (p.claimedBy === m.id) p.claimedBy = null; }
      m.state = "celebrating"; m.path = []; m.crate = null; m.plate = null;
    }
    const captive = this.captive();
    this.say("Puzzle", captive
      ? `All supplies delivered - the crew did it! ${captive.name} is still in jail.`
      : "All supplies delivered - the crew did it!");
  }

  tick(dt: number) {
    if (this.paused || dt <= 0) return;
    if (this.status !== "running") return;
    if (this.controller?.budgetExhausted?.()) { this.failBudget(); return; } // latch on the next tick, not the next dispatch round
    this.t += dt;
    this.elapsed += dt * this.speed;
    for (const m of this.members) if (m.bubbleUntil < this.t) m.bubble = null;

    this.dispatchT += dt * this.speed;
    if (this.dispatchT >= DISPATCH_EVERY) { this.dispatchT = 0; this.dispatch(); }
    if (this.status !== "running") return; // dispatch may have failed the run

    for (const m of this.members) {
      // once the crew knows about the jailer, a chased mii drops everything and runs
      if (this.jailerAlert && this.jailer.active && this.jailer.targetId === m.id
          && m.state !== "fleeing" && m.state !== "jailed" && m.state !== "celebrating") {
        this.startFlee(m);
      }
      switch (m.state) {
        case "idle": {
          m.wanderT -= dt * this.speed;
          if (m.wanderT <= 0) {
            m.wanderT = 2 + this.rng() * 3;
            const campD = bfs(
              new Set([...this.carvedSet].filter((k) => k !== ekey(this.layout.door.ax, this.layout.door.ay, this.layout.door.bx, this.layout.door.by))),
              this.layout.camp,
            );
            const cells = [...campD.keys()].map((k) => {
              const [x, y] = k.split(",").map(Number);
              return { x, y };
            }).filter((c) => Math.abs(c.x - this.layout.camp.x) + Math.abs(c.y - this.layout.camp.y) <= 4);
            if (cells.length) {
              const spot = cells[Math.floor(this.rng() * cells.length)];
              const path = this.bfsPath(m.id, m.pos, center(spot), { skipDoor: true });
              if (path) { m.path = path; m.state = "wandering"; }
            }
          }
          break;
        }
        case "wandering": {
          if (this.step(m, dt)) m.state = "idle";
          break;
        }
        case "scouting": {
          if (this.step(m, dt)) m.state = "idle"; // looked, found nothing here
          else this.checkDiscovery(m);
          break;
        }
        case "toPlate": {
          // plates are camp-side: waiting at a shut door means the plate is
          // unreachable - release the claim so a camp-side mii can take it
          if (this.waitingAtShutDoor(m)) {
            const p = this.plates.find((q) => q.id === m.plate);
            if (p && p.claimedBy === m.id) p.claimedBy = null;
            m.plate = null; m.path = []; m.state = "idle";
            this.say(m.name, "can't reach the plate while the door is shut.", m);
            break;
          }
          if (this.step(m, dt) || dist(m.pos, center(this.plates.find((p) => p.id === m.plate)!.pos)) < PLATE_DIST) {
            const p = this.plates.find((q) => q.id === m.plate)!;
            p.heldBy = m.id; p.claimedBy = null;
            m.state = "holding"; m.path = [];
            this.say(m.name, `is holding ${p.id} down.`, m);
          }
          break;
        }
        case "holding": break; // stays until it decides (or is told) to release
        case "fetching": {
          const c = this.crates.find((q) => q.id === m.crate);
          if (!c || c.delivered) { m.state = "idle"; m.crate = null; break; }
          const arrived = this.step(m, dt);
          if (arrived || dist(m.pos, c.pos) < PICKUP_DIST) {
            m.state = "carrying";
            c.pos = { ...m.pos };
            const back = this.pathFor(m.id, m.pos, center(this.layout.camp));
            m.path = back ?? [];
            m.repathT = 0;
            this.say(m.name, `picked up ${c.id} - heading back to camp.`, m);
          } else if (!m.path.length) {
            this.repathIfWaiting(m, dt, c.pos);
          }
          break;
        }
        case "carrying": {
          const c = this.crates.find((q) => q.id === m.crate);
          if (c) c.pos = { ...m.pos };
          const arrived = this.step(m, dt);
          if (arrived || dist(m.pos, center(this.layout.camp)) < DELIVER_DIST) {
            if (c) {
              c.delivered = true; c.pos = center(this.layout.camp);
              if (c.golden) this.cacheDeliveredBy = m.name;
            }
            m.state = "idle"; m.crate = null;
            this.say(m.name, c?.golden
              ? `delivered the GOLDEN cache crate to camp - bonus loot from the hidden room!`
              : `delivered ${c?.id ?? "a crate"} to camp (${this.deliveredCount()}/${this.totalCount()}).`, m);
            if (this.deliveredCount() === this.totalCount()) this.complete();
          } else if (!m.path.length) {
            this.repathIfWaiting(m, dt, center(this.layout.camp));
          }
          break;
        }
        case "fleeing": {
          const j = this.jailer;
          if (!j.active || j.targetId !== m.id) { m.state = "idle"; break; }
          // bolt down the corridor that takes it furthest from the jailer
          const cx = Math.floor(m.pos.x), cy = Math.floor(m.pos.y);
          let bestNext: Vec | null = null;
          let bestD = dist(m.pos, j.pos);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
            if (!this.edgeOpen(m.id, cx, cy, nx, ny)) continue;
            const d = dist(center({ x: nx, y: ny }), j.pos);
            if (d > bestD) { bestD = d; bestNext = center({ x: nx, y: ny }); }
          }
          if (bestNext) { m.path = [bestNext]; this.step(m, dt, FLEE_SPEED_MULT); }
          break;
        }
        case "toKey": {
          if (!this.key) { m.state = "idle"; break; }
          if (this.waitingAtShutDoor(m)) {
            if (this.key.claimedBy === m.id) this.key.claimedBy = null;
            m.path = []; m.state = "idle";
            this.say(m.name, "can't reach the jail key while the door is shut.", m);
            break;
          }
          const arrived = this.step(m, dt);
          if (arrived || dist(m.pos, this.key.pos) < PICKUP_DIST) {
            this.key.carriedBy = m.id; this.key.claimedBy = null;
            m.state = "toJail";
            m.path = this.pathForMember(m, center(this.layout.jail)) ?? [];
            m.repathT = 0;
            this.say(m.name, "grabbed the jail key - heading to the jail.", m);
          } else if (!m.path.length) {
            this.repathIfWaiting(m, dt, this.key.pos);
          }
          break;
        }
        case "toJail": {
          if (this.key && this.key.carriedBy === m.id) this.key.pos = { ...m.pos };
          const arrived = this.step(m, dt);
          if (arrived || dist(m.pos, center(this.layout.jail)) < DELIVER_DIST) {
            const captive = this.captive();
            this.key = null;
            m.state = "idle";
            if (captive) {
              captive.state = "idle";
              this.rescues.push({ by: m.id, name: m.name, freed: captive.name, t: this.elapsed });
              this.say(m.name, `unlocked the jail - ${captive.name} is free!`, m);
              this.jailer.active = true;
              // respawn far from the crew, not beside the rescue it just lost -
              // and re-post there so it patrols the far corner instead of
              // walking straight back through the crew's corridors
              this.jailer.pos = center(this.respawnSpot());
              this.jailer.post = { ...this.jailer.pos };
              this.jailer.path = []; this.jailer.targetId = null; this.jailer.wanderT = 1.5;
              this.say("Puzzle", "The jailer is back on patrol, far from the crew.");
            }
          } else if (!m.path.length) {
            this.repathIfWaiting(m, dt, center(this.layout.jail));
          }
          break;
        }
        case "jailed": break;
        case "celebrating": break;
      }
    }

    // the jailer hunts after the crew has moved
    this.jailerTick(dt);

    // door transitions land in the same tick that caused them
    const open = this.doorOpen();
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      if (this.status !== "running") return; // completion released the plates - no door commentary after the win
      this.say("Puzzle", open
        ? "Both plates are held - the stone door rumbles open."
        : "A plate was released - the stone door grinds shut.");
      if (open) {
        for (const m of this.members) {
          if ((m.state === "fetching" || m.state === "carrying") && !m.path.length) m.repathT = 0;
        }
      }
    }
  }

  snapshot(): MazeSnapshot {
    return {
      t: this.t,
      elapsed: this.elapsed,
      status: this.status,
      failureReason: this.failureReason,
      paused: this.paused,
      speed: this.speed,
      seed: this.seed,
      w: MAZE_W,
      h: MAZE_H,
      carved: [...this.carvedSet],
      door: { ...this.layout.door, open: this.doorOpen() },
      plates: this.plates.map((p) => ({
        id: p.id, x: p.pos.x, y: p.pos.y, heldBy: p.heldBy, claimedBy: p.claimedBy,
      })),
      crack: this.layout.crack ? {
        ...this.layout.crack,
        foundByAnyone: this.discovered.size > 0 || this.shared !== null,
        sharedBy: this.shared?.name ?? null,
        knownBy: this.members.filter((m) => this.knowsCrack(m.id)).map((m) => m.name),
      } : null,
      chamber: this.layout.chamber,
      camp: this.layout.camp,
      members: this.members.map((m) => ({
        id: m.id, name: m.name, color: m.color,
        x: m.pos.x, y: m.pos.y, state: m.state,
        carrying: m.state === "carrying", bubble: m.bubble,
        path: m.path.map((p) => ({ ...p })),
      })),
      crates: this.crates.map((c) => ({
        id: c.id, x: c.pos.x, y: c.pos.y, claimedBy: c.claimedBy, delivered: c.delivered, golden: c.golden,
      })),
      delivered: this.deliveredCount(),
      total: this.totalCount(),
      sharingAllowed: this.sharingAllowed,
      jail: { ...this.layout.jail },
      jailer: {
        active: this.jailer.active,
        x: this.jailer.pos.x, y: this.jailer.pos.y,
        chasing: this.jailer.targetId ? (this.member(this.jailer.targetId)?.name ?? null) : null,
      },
      key: this.key ? {
        x: this.key.pos.x, y: this.key.pos.y,
        claimedBy: this.key.claimedBy, carriedBy: this.key.carriedBy,
      } : null,
      captiveId: this.captive()?.id ?? null,
      jailerAlert: this.jailerAlert,
      log: this.log.slice(-60),
      stats: {
        discoveries: [...this.discoveries],
        shares: this.shared ? [this.shared] : [],
        routeUpdates: [...this.routeUpdates],
        cacheDeliveredBy: this.cacheDeliveredBy,
        captures: [...this.captures],
        rescues: [...this.rescues],
      },
    };
  }
}
