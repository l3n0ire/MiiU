// Bridge puzzle engine (cooperative goal mode): pure logic, no DOM, no LLM.
// The crew's planning is code-driven (a simple task-assignment state machine),
// NOT learned or model-reasoned - the point of this mode is watching the Miis
// carry, help and place pieces toward a visible goal. Conversation-style chatter
// is emitted as short template lines and is hidden by default in the UI.

export interface Vec { x: number; y: number }
export interface CrewMember { id: string; name: string; color: string }

export const PUZZLE_W = 20;
export const PUZZLE_H = 15;
export const RIVER_X0 = 9; // first water column
export const RIVER_X1 = 11; // last water column
export const BRIDGE_Y = 7; // row the bridge crosses on
export const FLAG: Vec = { x: 16, y: 7 };

const BASE_SPEED = 3; // tiles per second at speed=1
const PICKUP_DIST = 0.55;
const PLACE_TIME = 0.7; // seconds to set a piece down
const HELPER_NEAR = 1.6; // helper must be this close to the lead to place

export type PieceKind = "block" | "beam";
export type PieceState = "idle" | "claimed" | "carried" | "placed";

export interface Piece {
  id: string;
  kind: PieceKind;
  heavy: boolean; // beams need two carriers
  pos: Vec; // current tile (idle) or live position (carried)
  home: Vec; // where it starts
  target: Vec; // bridge cell it must fill
  state: PieceState;
  lead: string | null; // carrier member id
  helper: string | null; // second carrier for heavy pieces
  placeT: number; // countdown while placing
}

export type MemberState =
  | "idle" | "wandering" | "fetching" | "waiting" | "helping"
  | "carrying" | "placing" | "crossing" | "celebrating";

export interface Member {
  id: string;
  name: string;
  color: string;
  pos: Vec;
  path: Vec[]; // tile-center waypoints
  state: MemberState;
  piece: string | null; // piece id being fetched/carried
  bubble: string | null;
  bubbleUntil: number; // sim seconds
  wanderT: number;
}

export interface ChatterLine { t: number; speaker: string; text: string }

export interface PuzzleSnapshot {
  t: number;
  elapsed: number;
  status: "building" | "complete";
  paused: boolean;
  speed: number;
  members: (CrewMember & { x: number; y: number; state: MemberState; carrying: PieceKind | null; bubble: string | null })[];
  pieces: { id: string; kind: PieceKind; heavy: boolean; x: number; y: number; state: PieceState; carriers: string[] }[];
  bridge: { x: number; y: number; filled: boolean }[];
  flag: Vec;
  placedCount: number;
  totalPieces: number;
  assists: number; // heavy lifts completed
  log: ChatterLine[];
}

// Deterministic RNG so tests and replays are stable.
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

const CHATTER = {
  claimBlock: ["I'll grab this block!", "Got this one!", "On it - block coming through!"],
  claimBeam: ["This beam is heavy - I need a hand!", "No way I lift this alone. Help?", "Two-person job here!"],
  helpAccept: ["On my way!", "Coming to help!", "I've got the other end!"],
  pickupBeam: ["Lift! One, two...", "Heave!", "Okay, we got it!"],
  place: ["One down!", "Set! That fits!", "Nice - locked in!"],
  beamPlaced: ["That's the big one in!", "We make a good team!", "The bridge is real now!"],
  complete: ["We did it!!", "Bridge!! We built a bridge!", "Across! Let's go!"],
};

export class BridgePuzzle {
  members: Member[] = [];
  pieces: Piece[] = [];
  t = 0;
  elapsed = 0; // speed-scaled active seconds, for the completion stat
  speed = 1;
  paused = false;
  status: "building" | "complete" = "building";
  log: ChatterLine[] = [];
  assists = 0;
  private rng: () => number;
  private crossed = new Set<string>();

  constructor(crew: CrewMember[], seed = 7) {
    this.rng = mulberry32(seed);
    const spawns: Vec[] = [{ x: 2, y: 6 }, { x: 2, y: 8 }, { x: 1, y: 7 }, { x: 3, y: 7 }];
    this.members = crew.slice(0, 4).map((c, i) => ({
      ...c,
      pos: center(spawns[i % spawns.length]),
      path: [],
      state: "idle",
      piece: null,
      bubble: null,
      bubbleUntil: 0,
      wanderT: 1 + i * 0.7,
    }));
    // Two light blocks fill the outer gap cells; one heavy beam fills the middle.
    this.pieces = [
      { id: "block-a", kind: "block", heavy: false, home: { x: 4, y: 3 }, pos: center({ x: 4, y: 3 }), target: { x: RIVER_X0, y: BRIDGE_Y }, state: "idle", lead: null, helper: null, placeT: 0 },
      { id: "beam", kind: "beam", heavy: true, home: { x: 3, y: 11 }, pos: center({ x: 3, y: 11 }), target: { x: RIVER_X0 + 1, y: BRIDGE_Y }, state: "idle", lead: null, helper: null, placeT: 0 },
      { id: "block-b", kind: "block", heavy: false, home: { x: 6, y: 12 }, pos: center({ x: 6, y: 12 }), target: { x: RIVER_X1, y: BRIDGE_Y }, state: "idle", lead: null, helper: null, placeT: 0 },
    ];
  }

  placedCount(): number { return this.pieces.filter((p) => p.state === "placed").length; }

  isWater(x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < RIVER_X0 || xi > RIVER_X1 || yi < 0 || yi >= PUZZLE_H) return false;
    return true;
  }

  walkable(x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= PUZZLE_W || yi >= PUZZLE_H) return false;
    if (!this.isWater(x, y)) return true;
    // Water is walkable only where a piece has been placed on the bridge row.
    return yi === BRIDGE_Y && this.pieces.some((p) => p.state === "placed" && p.target.x === xi);
  }

  // BFS over tile centers; returns waypoints excluding start, including goal.
  private findPath(from: Vec, to: Vec): Vec[] | null {
    const s = { x: Math.floor(from.x), y: Math.floor(from.y) };
    const g = { x: Math.floor(to.x), y: Math.floor(to.y) };
    if (!this.walkable(g.x + 0.5, g.y + 0.5)) return null;
    const key = (x: number, y: number) => `${x},${y}`;
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
        const nk = key(nx, ny);
        if (seen.has(nk) || !this.walkable(nx + 0.5, ny + 0.5)) continue;
        seen.add(nk); prev.set(nk, key(c.x, c.y)); q.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  // A cell next to the target the carrier can stand on to place the piece.
  private standCell(p: Piece, from: Vec): Vec | null {
    const t = p.target;
    const options = [{ x: t.x - 1, y: t.y }, { x: t.x + 1, y: t.y }, { x: t.x, y: t.y - 1 }, { x: t.x, y: t.y + 1 }];
    let best: Vec | null = null, bestLen = Infinity;
    for (const o of options) {
      if (!this.walkable(o.x + 0.5, o.y + 0.5)) continue;
      const path = this.findPath(from, { x: o.x + 0.5, y: o.y + 0.5 });
      if (path && path.length < bestLen) { best = o; bestLen = path.length; }
    }
    return best;
  }

  private say(m: Member, text: string) {
    m.bubble = text;
    m.bubbleUntil = this.t + 3.5;
    this.log.push({ t: this.t, speaker: m.name, text });
    if (this.log.length > 200) this.log.shift();
  }

  private pick(arr: string[]): string { return arr[Math.floor(this.rng() * arr.length)]; }

  private free(m: Member): boolean { return m.state === "idle" || m.state === "wandering"; }

  private member(id: string | null): Member | undefined { return this.members.find((m) => m.id === id); }

  private assign() {
    // Pieces must be placed in bridge order: each target's stand cell only
    // becomes reachable once the previous gap cell is filled.
    for (const p of this.pieces) {
      if (p.state !== "idle" && p.state !== "claimed") continue;
      const standFrom = this.members[0]?.pos ?? { x: 1, y: BRIDGE_Y };
      // Assignment feasibility: could anybody stand next to the target right now?
      if (!this.standCell(p, standFrom)) continue;
      const freeMembers = this.members.filter((m) => this.free(m));
      if (!freeMembers.length) continue;
      const byNear = [...freeMembers].sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos));
      if (!p.heavy) {
        if (p.state === "idle") {
          const m = byNear[0];
          p.state = "claimed"; p.lead = m.id;
          m.state = "fetching"; m.piece = p.id;
          m.path = this.findPath(m.pos, p.pos) ?? [];
          this.say(m, this.pick(CHATTER.claimBlock));
        }
      } else {
        if (p.state === "idle") {
          const lead = byNear[0];
          p.state = "claimed"; p.lead = lead.id;
          lead.state = "fetching"; lead.piece = p.id;
          lead.path = this.findPath(lead.pos, p.pos) ?? [];
          this.say(lead, this.pick(CHATTER.claimBeam));
        }
        if (!p.helper && byNear.length > (p.lead && freeMembers.some((m) => m.id === p.lead) ? 0 : -1)) {
          const helper = freeMembers.find((m) => m.id !== p.lead);
          if (helper) {
            p.helper = helper.id;
            helper.state = "helping"; helper.piece = p.id;
            helper.path = this.findPath(helper.pos, p.pos) ?? [];
            this.say(helper, this.pick(CHATTER.helpAccept));
          }
        }
      }
    }
  }

  private step(m: Member, dt: number): boolean {
    // Move along waypoints; true when the path is finished.
    let budget = BASE_SPEED * this.speed * dt;
    while (budget > 0 && m.path.length) {
      const next = m.path[0];
      const d = dist(m.pos, next);
      if (d <= budget) { m.pos = next; m.path.shift(); budget -= d; }
      else {
        m.pos = { x: m.pos.x + ((next.x - m.pos.x) / d) * budget, y: m.pos.y + ((next.y - m.pos.y) / d) * budget };
        budget = 0;
      }
    }
    return m.path.length === 0;
  }

  private startCarry(p: Piece) {
    p.state = "carried";
    const lead = this.member(p.lead)!;
    lead.state = "carrying";
    const stand = this.standCell(p, lead.pos);
    lead.path = stand ? this.findPath(lead.pos, { x: stand.x + 0.5, y: stand.y + 0.5 }) ?? [] : [];
    if (p.heavy) {
      const helper = this.member(p.helper!);
      if (helper) { helper.state = "carrying"; helper.path = []; }
      this.say(lead, this.pick(CHATTER.pickupBeam));
    }
  }

  private finishPlace(p: Piece) {
    p.state = "placed";
    p.pos = center(p.target);
    const lead = this.member(p.lead);
    if (lead) { lead.state = "idle"; lead.piece = null; }
    if (p.helper) {
      const helper = this.member(p.helper);
      if (helper) { helper.state = "idle"; helper.piece = null; }
      this.assists += 1;
      if (lead) this.say(lead, this.pick(CHATTER.beamPlaced));
    } else if (lead) this.say(lead, this.pick(CHATTER.place));
    if (this.placedCount() === this.pieces.length) {
      // Bridge complete: everyone crosses to the flag.
      const spots = [FLAG, { x: 16, y: 6 }, { x: 16, y: 8 }, { x: 17, y: 7 }];
      this.members.forEach((m, i) => {
        m.state = "crossing"; m.piece = null;
        const spot = spots[i % spots.length];
        m.path = this.findPath(m.pos, { x: spot.x + 0.5, y: spot.y + 0.5 }) ?? [];
      });
      const first = this.members[0];
      if (first) this.say(first, this.pick(CHATTER.complete));
    }
  }

  tick(dt: number) {
    if (this.paused || dt <= 0) return;
    this.t += dt;
    this.elapsed += dt * this.speed;
    for (const m of this.members) if (m.bubbleUntil < this.t) m.bubble = null;

    if (this.status === "building") this.assign();

    for (const m of this.members) {
      switch (m.state) {
        case "idle": {
          m.wanderT -= dt * this.speed;
          if (m.wanderT <= 0) {
            m.wanderT = 2 + this.rng() * 3;
            // Idle members mill around the left-bank staging area.
            const spot = { x: 1 + this.rng() * 6, y: 4 + this.rng() * 7 };
            const path = this.findPath(m.pos, { x: Math.floor(spot.x) + 0.5, y: Math.floor(spot.y) + 0.5 });
            if (path) { m.path = path; m.state = "wandering"; }
          }
          break;
        }
        case "wandering": {
          if (this.step(m, dt)) m.state = "idle";
          break;
        }
        case "fetching": {
          const p = this.pieces.find((q) => q.id === m.piece);
          if (!p) { m.state = "idle"; break; }
          if (this.step(m, dt) || dist(m.pos, p.pos) < PICKUP_DIST) {
            if (!p.heavy) { this.startCarry(p); }
            else {
              // Heavy piece: wait at the beam until the helper arrives.
              m.state = "waiting";
              const helper = this.member(p.helper);
              if (helper && dist(helper.pos, p.pos) < PICKUP_DIST) this.startCarry(p);
            }
          }
          break;
        }
        case "waiting": {
          const p = this.pieces.find((q) => q.id === m.piece);
          const helper = p && this.member(p.helper);
          if (p && helper && dist(helper.pos, p.pos) < PICKUP_DIST && dist(m.pos, p.pos) < PICKUP_DIST + 0.3) this.startCarry(p);
          break;
        }
        case "helping": {
          const p = this.pieces.find((q) => q.id === m.piece);
          if (!p) { m.state = "idle"; break; }
          if (this.step(m, dt) || dist(m.pos, p.pos) < PICKUP_DIST) {
            const lead = this.member(p.lead);
            if (lead && lead.state === "waiting" && dist(lead.pos, p.pos) < PICKUP_DIST + 0.3) this.startCarry(p);
          }
          break;
        }
        case "carrying": {
          const p = this.pieces.find((q) => q.id === m.piece);
          if (!p) { m.state = "idle"; break; }
          if (p.lead === m.id) {
            const done = this.step(m, dt);
            p.pos = { ...m.pos }; // the piece rides with the lead carrier
            const helper = p.helper ? this.member(p.helper) : null;
            if (done) {
              if (!helper || dist(helper.pos, m.pos) < HELPER_NEAR) { m.state = "placing"; p.placeT = PLACE_TIME; }
              // else: lead holds position at the stand cell until the helper catches up
            }
          } else {
            // Helper: stay glued to the lead while carrying together.
            const lead = this.member(p.lead);
            if (lead) {
              const d = dist(m.pos, lead.pos);
              const want = 0.9;
              if (d > want) {
                const stepLen = Math.min(d - want, BASE_SPEED * this.speed * dt);
                m.pos = { x: m.pos.x + ((lead.pos.x - m.pos.x) / d) * stepLen, y: m.pos.y + ((lead.pos.y - m.pos.y) / d) * stepLen };
              }
              if (lead.state === "placing") { m.state = "placing"; }
            }
          }
          break;
        }
        case "placing": {
          const p = this.pieces.find((q) => q.id === m.piece);
          if (!p) { m.state = "idle"; break; }
          if (p.lead === m.id) {
            p.placeT -= dt * this.speed;
            if (p.placeT <= 0) this.finishPlace(p);
          }
          break;
        }
        case "crossing": {
          if (this.step(m, dt)) {
            m.state = "celebrating";
            if (!this.crossed.has(m.id)) {
              this.crossed.add(m.id);
              if (this.status === "building") this.status = "complete";
            }
          }
          break;
        }
        case "celebrating": break;
      }
    }
  }

  snapshot(): PuzzleSnapshot {
    return {
      t: this.t,
      elapsed: this.elapsed,
      status: this.status,
      paused: this.paused,
      speed: this.speed,
      members: this.members.map((m) => ({
        id: m.id, name: m.name, color: m.color,
        x: m.pos.x, y: m.pos.y, state: m.state,
        carrying: m.piece ? this.pieces.find((p) => p.id === m.piece && p.state === "carried")?.kind ?? null : null,
        bubble: m.bubble,
      })),
      pieces: this.pieces.map((p) => ({
        id: p.id, kind: p.kind, heavy: p.heavy,
        x: p.pos.x, y: p.pos.y, state: p.state,
        carriers: [p.lead, p.helper].filter((v): v is string => !!v && p.state === "carried"),
      })),
      bridge: [RIVER_X0, RIVER_X0 + 1, RIVER_X1].map((x) => ({
        x, y: BRIDGE_Y,
        filled: this.pieces.some((p) => p.state === "placed" && p.target.x === x),
      })),
      flag: FLAG,
      placedCount: this.placedCount(),
      totalPieces: this.pieces.length,
      assists: this.assists,
      log: this.log.slice(-50),
    };
  }
}
