// The Long Crossing: a harder cooperative puzzle - pure logic, no DOM, no LLM.
//
// Same decision honesty bar as the bridge puzzle (web/puzzle-engine.ts), but
// a genuinely harder layout:
//   - TWO rivers with a rocky island between them. The crew must bridge the
//     first river, FERRY materials over that bridge, then bridge the second
//     river before anyone can reach the flag.
//   - Six pieces instead of three, three of them heavy beams that each need
//     two carriers - with four miis, two simultaneous lifts consume the whole
//     crew, so who answers which ask actually matters.
//   - One of the far bridge's beams starts on the HOME bank: two miis must
//     carry it across the finished first bridge before the second bridge can
//     even start. Sequencing is discovered from walkability, not scripted -
//     a far gap's stand cell is unreachable until the path over bridge one
//     and the preceding far gaps exists.
//
// DECISION MECHANISM (same as the bridge puzzle): a feasibility-driven task
// assigner picks jobs greedily by distance among free members, re-evaluated
// every tick. It is NOT a general planner with backtracking, NOT learned
// behavior, and the miis do not negotiate on their own.
//
// OPTIONAL MODEL CONTROL: a CrewController (web/puzzle-minds.ts, with the
// crossing scenario text) can replace the assignment step with per-character
// LLM decisions - each mii its own calls, memory, asks, accepts and
// declines. The engine revalidates every decision before applying it, and
// all movement, pathing, lifting and placing stay code-driven. Without a
// connected model the built-in assigner runs and the UI says so.

export interface Vec { x: number; y: number }
export interface CrewMember { id: string; name: string; color: string }

export const CROSS_W = 24;
export const CROSS_H = 15;

const BASE_SPEED = 3; // tiles per second at speed=1
const PICKUP_DIST = 0.55;
const PLACE_TIME = 0.7;
const HELPER_NEAR = 1.6;

export type PieceKind = "block" | "beam";
export type PieceState = "idle" | "claimed" | "carried" | "placed";

export interface Piece {
  id: string;
  kind: PieceKind;
  heavy: boolean;
  bridge: number; // 0 = first river's bridge, 1 = second
  pos: Vec;
  home: Vec;
  target: Vec;
  state: PieceState;
  lead: string | null;
  helper: string | null;
  placeT: number;
}

export type MemberState =
  | "idle" | "wandering" | "fetching" | "waiting" | "helping"
  | "carrying" | "placing" | "crossing" | "celebrating";

export interface Member {
  id: string;
  name: string;
  color: string;
  pos: Vec;
  path: Vec[];
  state: MemberState;
  piece: string | null;
  bubble: string | null;
  bubbleUntil: number;
  wanderT: number;
}

export interface ChatterLine { t: number; speaker: string; text: string }

// Decision surface handed to an optional CrewController - mirrors exactly
// what the built-in assigner can act on.
export interface DecisionView {
  pieces: {
    id: string; kind: PieceKind; heavy: boolean; bridge: number; home: Vec; target: Vec;
    claimed: boolean; placed: boolean; placeable: boolean;
    distances: { member: string; d: number }[];
  }[];
  members: { id: string; name: string; free: boolean; x: number; y: number }[];
  inProgress: { piece: string; lead: string; helper: string | null; state: PieceState }[];
}

export interface AssignmentDecision { piece: string; lead: string; helper?: string }

export interface PartialReply { decisions: AssignmentDecision[]; builtinFor: string[] }
export type ControllerReply = AssignmentDecision[] | PartialReply | "pending" | "fallback";
export interface CrewController {
  decide(view: DecisionView): ControllerReply;
  applied?(a: AssignmentDecision): void;
  // true = the run was declared failed (e.g. call budget exhausted): the
  // engine must not advance AT ALL - no walking, placing, crossing or win -
  // until a fresh puzzle replaces the controller state.
  failed?(): boolean;
}

export interface RiverSpan { x0: number; x1: number; bridgeY: number }

export interface CrossLayout {
  rivers: [RiverSpan, RiverSpan];
  flag: Vec;
  pieces: { id: string; kind: PieceKind; heavy: boolean; bridge: number; home: Vec; target: Vec }[];
  spawns: Vec[];
}

export interface CrossSnapshot {
  t: number;
  elapsed: number;
  status: "building" | "crossing" | "complete";
  paused: boolean;
  speed: number;
  seed: number;
  rivers: RiverSpan[];
  members: (CrewMember & { x: number; y: number; state: MemberState; carrying: PieceKind | null; bubble: string | null })[];
  pieces: { id: string; kind: PieceKind; heavy: boolean; bridge: number; x: number; y: number; state: PieceState; carriers: string[] }[];
  gaps: { x: number; y: number; bridge: number; filled: boolean }[];
  flag: Vec;
  placedCount: number;
  crossedCount: number;
  totalPieces: number;
  assists: number;
  log: ChatterLine[];
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

// Generate a solvable two-river layout from a seed. Guarantees:
// - river 1 is 3 cells wide somewhere left of center; an island 2-3 cells
//   wide; river 2 is 3 cells wide with room for the flag on the far bank;
// - the two bridge rows are far apart (different halves of the map);
// - bridge 1 gets one beam + two blocks, all homed on the home bank;
// - bridge 2 gets one block and one beam homed on the ISLAND (reachable only
//   over bridge 1) plus one beam homed on the HOME bank (must be ferried
//   across bridge 1 by two carriers);
// - piece targets within each bridge are shuffled so the ferry beam is not
//   always the same gap.
export function generateCrossLayout(seed: number): CrossLayout {
  const rng = mulberry32(seed * 2654435761 + 4177);
  const r1x0 = 5 + Math.floor(rng() * 2); // 5..6
  const r1: RiverSpan = { x0: r1x0, x1: r1x0 + 2, bridgeY: 3 + Math.floor(rng() * 4) }; // 3..6
  const islandW = 2 + Math.floor(rng() * 2); // 2..3
  const r2x0 = r1.x1 + 1 + islandW;
  const r2: RiverSpan = { x0: r2x0, x1: r2x0 + 2, bridgeY: 8 + Math.floor(rng() * 4) }; // 8..11
  const flag = {
    x: Math.min(CROSS_W - 2, r2.x1 + 2 + Math.floor(rng() * 2)),
    y: Math.max(1, Math.min(CROSS_H - 2, r2.bridgeY + Math.floor(rng() * 3) - 1)),
  };

  const islandX = (i: number) => r1.x1 + 1 + (i % islandW);
  const homeBankSpots: Vec[] = [];
  let guard = 0;
  while (homeBankSpots.length < 4 && guard++ < 800) {
    const h = {
      x: 1 + Math.floor(rng() * Math.max(2, r1x0 - 3)),
      y: 1 + Math.floor(rng() * (CROSS_H - 2)),
    };
    if (homeBankSpots.every((o) => Math.abs(o.x - h.x) + Math.abs(o.y - h.y) >= 3)) homeBankSpots.push(h);
  }
  while (homeBankSpots.length < 4) homeBankSpots.push({ x: 1 + homeBankSpots.length, y: 2 + homeBankSpots.length * 3 });

  // Bridge 1 pieces: one beam, two blocks, shuffled across the three gaps.
  const b1: { kind: PieceKind }[] = [{ kind: "beam" }, { kind: "block" }, { kind: "block" }];
  for (let i = b1.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b1[i], b1[j]] = [b1[j], b1[i]]; }
  // Bridge 2 pieces: island block, island beam, home-bank (ferry) beam,
  // shuffled across the three far gaps.
  const b2: { kind: PieceKind; where: "island" | "home" }[] = [
    { kind: "block", where: "island" }, { kind: "beam", where: "island" }, { kind: "beam", where: "home" },
  ];
  for (let i = b2.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b2[i], b2[j]] = [b2[j], b2[i]]; }

  const pieces: CrossLayout["pieces"] = [];
  let blocks = 0, beams = 0, homes = 0;
  b1.forEach((p, i) => {
    const id = p.kind === "beam" ? `beam-${beams++}` : `block-${blocks++}`;
    pieces.push({
      id, kind: p.kind, heavy: p.kind === "beam", bridge: 0,
      home: homeBankSpots[homes++],
      target: { x: r1.x0 + i, y: r1.bridgeY },
    });
  });
  b2.forEach((p, i) => {
    const id = p.kind === "beam" ? `beam-${beams++}` : `block-${blocks++}`;
    pieces.push({
      id, kind: p.kind, heavy: p.kind === "beam", bridge: 1,
      home: p.where === "island"
        ? { x: islandX(i), y: Math.max(1, Math.min(CROSS_H - 2, r2.bridgeY + (i === 0 ? -2 : 2))) }
        : homeBankSpots[homes++],
      target: { x: r2.x0 + i, y: r2.bridgeY },
    });
  });

  const spawns: Vec[] = [];
  guard = 0;
  while (spawns.length < 4 && guard++ < 800) {
    const s = { x: Math.floor(rng() * Math.max(2, r1x0 - 2)), y: Math.floor(rng() * CROSS_H) };
    if (spawns.every((o) => Math.abs(o.x - s.x) + Math.abs(o.y - s.y) >= 2) &&
        homeBankSpots.every((o) => Math.abs(o.x - s.x) + Math.abs(o.y - s.y) >= 2)) spawns.push(s);
  }
  while (spawns.length < 4) spawns.push({ x: 0, y: spawns.length * 3 });
  return { rivers: [r1, r2], flag, pieces, spawns };
}

const CHATTER = {
  claimBlock: ["I'll grab this block!", "Got this one!", "On it - block coming through!"],
  claimBeam: ["This beam is heavy - I need a hand!", "No way I lift this alone. Help?", "Two-person job here!"],
  helpAccept: ["On my way!", "Coming to help!", "I've got the other end!"],
  pickupBeam: ["Lift! One, two...", "Heave!", "Okay, we got it!"],
  place: ["One down!", "Set! That fits!", "Nice - locked in!"],
  beamPlaced: ["That's the big one in!", "We make a good team!", "This bridge is real now!"],
  ferryBeam: ["Over the bridge with it!", "Careful on the planks...", "One beam, coming across!"],
  complete: ["Both bridges!! We did it!!", "Across twice! Let's go!", "Two rivers, one crew!"],
};

export class LongCrossing {
  members: Member[] = [];
  pieces: Piece[] = [];
  t = 0;
  elapsed = 0;
  speed = 1;
  paused = false;
  // building: pieces still unplaced. crossing: BOTH bridges done, crew en
  // route to the flag. complete: EVERY member has crossed - never before.
  status: "building" | "crossing" | "complete" = "building";
  log: ChatterLine[] = [];
  assists = 0;
  readonly seed: number;
  readonly layout: CrossLayout;
  private rng: () => number;
  private crossed = new Set<string>();
  private controller: CrewController | null = null;

  setController(c: CrewController | null) { this.controller = c; }

  constructor(crew: CrewMember[], seed = 7) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.layout = generateCrossLayout(seed);
    this.members = crew.slice(0, 4).map((c, i) => ({
      ...c,
      pos: center(this.layout.spawns[i % this.layout.spawns.length]),
      path: [],
      state: "idle",
      piece: null,
      bubble: null,
      bubbleUntil: 0,
      wanderT: 1 + i * 0.7,
    }));
    this.pieces = this.layout.pieces.map((p) => ({
      ...p,
      pos: center(p.home),
      state: "idle",
      lead: null,
      helper: null,
      placeT: 0,
    }));
  }

  placedCount(): number { return this.pieces.filter((p) => p.state === "placed").length; }
  bridgePlaced(b: number): number { return this.pieces.filter((p) => p.bridge === b && p.state === "placed").length; }

  private riverAt(xi: number): RiverSpan | null {
    for (const r of this.layout.rivers) if (xi >= r.x0 && xi <= r.x1) return r;
    return null;
  }

  isWater(x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (yi < 0 || yi >= CROSS_H) return false;
    return this.riverAt(xi) !== null;
  }

  walkable(x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= CROSS_W || yi >= CROSS_H) return false;
    const r = this.riverAt(xi);
    if (!r) return true;
    return yi === r.bridgeY && this.pieces.some((p) => p.state === "placed" && p.target.x === xi && p.target.y === yi);
  }

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

  decisionView(): DecisionView {
    const standFrom = this.members[0]?.pos ?? { x: 1, y: this.layout.rivers[0].bridgeY };
    const freeMembers = this.members.filter((m) => this.free(m));
    return {
      pieces: this.pieces.map((p) => ({
        id: p.id, kind: p.kind, heavy: p.heavy, bridge: p.bridge, home: p.home, target: p.target,
        claimed: p.state !== "idle", placed: p.state === "placed",
        placeable: p.state === "idle" && !!this.standCell(p, standFrom),
        distances: freeMembers.map((m) => ({ member: m.id, d: Math.round(dist(m.pos, p.pos) * 10) / 10 })),
      })),
      members: this.members.map((m) => ({ id: m.id, name: m.name, free: this.free(m), x: m.pos.x, y: m.pos.y })),
      inProgress: this.pieces
        .filter((p) => p.state !== "idle" && p.state !== "placed")
        .map((p) => ({ piece: p.id, lead: p.lead ?? "", helper: p.helper, state: p.state })),
    };
  }

  private claim(p: Piece, lead: Member, helper?: Member) {
    p.state = "claimed"; p.lead = lead.id;
    lead.state = "fetching"; lead.piece = p.id;
    lead.path = this.findPath(lead.pos, p.pos) ?? [];
    this.say(lead, this.pick(p.heavy ? CHATTER.claimBeam : CHATTER.claimBlock));
    if (helper) {
      p.helper = helper.id;
      helper.state = "helping"; helper.piece = p.id;
      helper.path = this.findPath(helper.pos, p.pos) ?? [];
      this.say(helper, this.pick(CHATTER.helpAccept));
    }
  }

  private applyDecision(a: AssignmentDecision): boolean {
    const p = this.pieces.find((q) => q.id === a.piece);
    if (!p || p.state !== "idle") return false;
    const standFrom = this.members[0]?.pos ?? { x: 1, y: this.layout.rivers[0].bridgeY };
    if (!this.standCell(p, standFrom)) return false;
    const lead = this.member(a.lead);
    if (!lead || !this.free(lead)) return false;
    if (p.heavy) {
      const helper = a.helper ? this.member(a.helper) : undefined;
      if (!helper || !this.free(helper) || helper.id === lead.id) return false;
      this.claim(p, lead, helper);
    } else {
      if (a.helper) return false;
      this.claim(p, lead);
    }
    return true;
  }

  private dispatch() {
    if (!this.controller) { this.assign(); return; }
    const view = this.decisionView();
    if (!view.pieces.some((p) => p.placeable) || !view.members.some((m) => m.free)) return;
    const out = this.controller.decide(view);
    if (out === "pending") return;
    if (out === "fallback") { this.assign(); return; }
    const partial = !Array.isArray(out);
    const decisions = partial ? out.decisions : out;
    const builtinFor = partial ? new Set(out.builtinFor) : null;
    let applied = 0;
    for (const a of decisions) if (this.applyDecision(a)) { applied++; this.controller.applied?.(a); }
    if (partial) { if (builtinFor && builtinFor.size) this.assign(builtinFor); }
    else if (applied === 0) this.assign();
  }

  // Feasibility-driven assignment, same rule as the bridge puzzle: only
  // pieces whose stand cell is reachable right now can be claimed, so the
  // crew discovers the workable order (bridge one, ferry, bridge two) from
  // the layout instead of following a script.
  private assign(onlyMembers?: Set<string>) {
    for (const p of this.pieces) {
      if (p.state !== "idle" && p.state !== "claimed") continue;
      if (onlyMembers && p.heavy) continue; // beams need two consenting carriers - minds only
      const standFrom = this.members[0]?.pos ?? { x: 1, y: this.layout.rivers[0].bridgeY };
      if (!this.standCell(p, standFrom)) continue;
      const freeMembers = this.members.filter((m) => this.free(m) && (!onlyMembers || onlyMembers.has(m.id)));
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
        if (!p.helper) {
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
      this.say(lead, this.pick(p.bridge === 1 && p.home.x < this.layout.rivers[0].x0 ? CHATTER.ferryBeam : CHATTER.pickupBeam));
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
      this.status = "crossing";
      const f = this.layout.flag;
      const spots = [f, { x: f.x, y: f.y - 1 }, { x: f.x, y: f.y + 1 }, { x: f.x + 1, y: f.y }]
        .filter((s) => this.walkable(s.x + 0.5, s.y + 0.5));
      this.members.forEach((m, i) => {
        m.state = "crossing"; m.piece = null;
        const spot = spots[i % spots.length] ?? f;
        m.path = this.findPath(m.pos, { x: spot.x + 0.5, y: spot.y + 0.5 }) ?? [];
      });
      const first = this.members[0];
      if (first) this.say(first, this.pick(CHATTER.complete));
    }
  }

  tick(dt: number) {
    if (this.paused || dt <= 0) return;
    if (this.controller?.failed?.()) return; // failed run: frozen before anything advances

    this.t += dt;
    this.elapsed += dt * this.speed;
    for (const m of this.members) if (m.bubbleUntil < this.t) m.bubble = null;

    if (this.status === "building") this.dispatch();
    if (this.controller?.failed?.()) return; // the run just failed inside dispatch: freeze before any advance/place/deliver

    for (const m of this.members) {
      switch (m.state) {
        case "idle": {
          m.wanderT -= dt * this.speed;
          if (m.wanderT <= 0) {
            m.wanderT = 2 + this.rng() * 3;
            const rx = this.layout.rivers[0].x0;
            const spot = { x: 1 + this.rng() * Math.max(1, rx - 3), y: 1 + this.rng() * (CROSS_H - 2) };
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
            p.pos = { ...m.pos };
            const helper = p.helper ? this.member(p.helper) : null;
            if (done) {
              if (!helper || dist(helper.pos, m.pos) < HELPER_NEAR) { m.state = "placing"; p.placeT = PLACE_TIME; }
            }
          } else {
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
              if (this.crossed.size === this.members.length) this.status = "complete";
            }
          }
          break;
        }
        case "celebrating": break;
      }
    }
  }

  snapshot(): CrossSnapshot {
    return {
      t: this.t,
      elapsed: this.elapsed,
      status: this.status,
      paused: this.paused,
      speed: this.speed,
      seed: this.seed,
      rivers: this.layout.rivers.map((r) => ({ ...r })),
      members: this.members.map((m) => ({
        id: m.id, name: m.name, color: m.color,
        x: m.pos.x, y: m.pos.y, state: m.state,
        carrying: m.piece ? this.pieces.find((p) => p.id === m.piece && p.state === "carried")?.kind ?? null : null,
        bubble: m.bubble,
      })),
      pieces: this.pieces.map((p) => ({
        id: p.id, kind: p.kind, heavy: p.heavy, bridge: p.bridge,
        x: p.pos.x, y: p.pos.y, state: p.state,
        carriers: [p.lead, p.helper].filter((v): v is string => !!v && p.state === "carried"),
      })),
      gaps: this.pieces.map((p) => ({
        x: p.target.x, y: p.target.y, bridge: p.bridge, filled: p.state === "placed",
      })).sort((a, b) => a.bridge - b.bridge || a.x - b.x),
      flag: this.layout.flag,
      placedCount: this.placedCount(),
      crossedCount: this.crossed.size,
      totalPieces: this.pieces.length,
      assists: this.assists,
      log: this.log.slice(-50),
    };
  }
}
