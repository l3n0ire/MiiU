// The Hidden Pass: a knowledge-sharing puzzle - pure logic, no DOM, no LLM.
//
// WHAT THIS DEMONSTRATES (read before claiming what this is):
// A rock ridge splits the island. The known way around it (the detour gap at
// one end) is long. Exactly one narrow hidden pass runs through the middle of
// the ridge - but NOBODY knows it at the start: pass tiles are treated as
// impassable rock in every mii's pathfinding until that mii either
//   (a) physically scouts the ridge and discovers the pass itself (proximity
//       while in the "scouting" state - an errand-runner walking past does
//       not examine the rocks), or
//   (b) is told by the crew, i.e. the discoverer CHOSE to share it.
// Knowledge is therefore private until shared, sharing is a decision (made by
// the model when one is connected), and every mii's routes are computed from
// its own knowledge only. Nothing about the pass - including its location -
// appears in a mii's decision view until that mii knows it.
//
// DECISION MECHANISM: per-mii decisions through an ExpeditionController
// (web/expedition-minds.ts when a model is connected): each mii chooses to
// fetch a crate, scout the ridge, share a discovery it personally made, or
// wait. The engine revalidates every decision (crate free, route exists with
// THAT mii's knowledge, scout target is genuinely unscouted, share only for
// an unshared personal discovery with sharing enabled). Movement, pathing,
// pickup and delivery stay code-driven. Route changes after a share are
// automatic re-planning with the new knowledge - the feed says exactly that
// ("route now goes through..."), never that the other mii independently
// reasoned its way to the pass.
//
// Without a controller the built-in assigner fetches the nearest reachable
// crate with public knowledge only. It never scouts and never shares, so the
// no-model baseline takes the long way - that contrast is part of the
// demonstration, and the UI says so.
//
// COMPARISON: a sharing on/off toggle plus same-layout restart lets a viewer
// compare runs. Those stats are descriptive (model choices are stochastic);
// they are not a controlled experiment.

export interface Vec { x: number; y: number }
export interface CrewMember { id: string; name: string; color: string }

export const EXP_W = 24;
export const EXP_H = 15;

const BASE_SPEED = 3; // tiles per second at speed=1
const SIGHT = 1.8; // scouting discovery radius around pass tiles
const PICKUP_DIST = 0.6;
const DELIVER_DIST = 0.9;
const DISPATCH_EVERY = 0.4; // seconds of scaled time between decision rounds

export type MemberState =
  | "idle" | "wandering" | "scouting" | "fetching" | "carrying" | "celebrating";

export interface Member {
  id: string;
  name: string;
  color: string;
  pos: Vec;
  path: Vec[];
  state: MemberState;
  crate: string | null;
  bubble: string | null;
  bubbleUntil: number;
  wanderT: number;
}

export interface Crate {
  id: string;
  pos: Vec;
  home: Vec;
  claimedBy: string | null;
  delivered: boolean;
}

export interface FeedLine { t: number; speaker: string; text: string }

export interface ExpeditionLayout {
  rx0: number; rx1: number; // ridge columns (2 wide)
  ridgeTop: number; ridgeBottom: number; // ridge rows (inclusive); the detour is outside these
  passY: number; // the one hidden pass row
  detourTop: boolean;
  camp: Vec;
  crates: { id: string; home: Vec }[];
  spawns: Vec[];
}

// Per-member decision surface. It contains ONLY what this mii knows: no pass
// location unless it discovered or was told, crate route lengths computed
// with its own knowledge, and share offered only for its own unshared
// discovery with sharing enabled.
export interface MemberView {
  me: { id: string; name: string; x: number; y: number; carrying: boolean };
  others: { id: string; name: string; free: boolean; x: number; y: number }[];
  delivered: number;
  total: number;
  crates: {
    id: string;
    x: number | null; y: number | null; // null while carried: live positions must not leak routes
    claimedBy: string | null; delivered: boolean;
    carriedBy: string | null; // carrier's name while the crate is on the move
    routeTiles: number | null; // one-way path length with THIS mii's knowledge
  }[];
  camp: Vec;
  detour: Vec; // the known, public gap at the far end of the ridge (everyone knows it)
  passIKnow: { x: number; y: number; foundBy: string } | null; // foundBy "me" or a name
  iFoundUnshared: { x: number; y: number } | null;
  canScout: boolean;
  sharingAllowed: boolean;
  announcements: string[]; // public board: claims and shares only
}

export interface ExpeditionDecision {
  action: "fetch" | "scout" | "share" | "wait";
  crate?: string;
  reason: string;
}

export interface ExpeditionController {
  decide(view: MemberView): ExpeditionDecision | "pending" | "fallback";
  applied?(memberId: string, d: ExpeditionDecision): void;
  rejected?(memberId: string, d: ExpeditionDecision, why: string): void;
  budgetExhausted?(): boolean;
  runFailed?(): void; // the run just failed on the budget wall - freeze minds, discard late replies
}

export interface ExpeditionSnapshot {
  t: number;
  elapsed: number;
  status: "running" | "complete" | "failed";
  failureReason: string | null;
  paused: boolean;
  speed: number;
  seed: number;
  ridge: { rx0: number; rx1: number; top: number; bottom: number };
  pass: { y: number; foundByAnyone: boolean; sharedBy: string | null; knownBy: string[] };
  camp: Vec;
  members: (CrewMember & { x: number; y: number; state: MemberState; carrying: boolean; bubble: string | null; path: Vec[] })[];
  crates: { id: string; x: number; y: number; claimedBy: string | null; delivered: boolean }[];
  delivered: number;
  total: number;
  sharingAllowed: boolean;
  log: FeedLine[];
  stats: {
    discoveries: { by: string; name: string; t: number }[];
    shares: { by: string; name: string; t: number }[];
    routeUpdates: { member: string; name: string; via: string; t: number }[];
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

// Generate a layout: a 2-column ridge splitting the island, a known detour
// gap at one end, and exactly one hidden pass in the OPPOSITE half (so the
// walk to the detour never passes within sight of the hidden pass - finding
// it takes a deliberate scouting trip, never an accident on an errand).
export function generateExpeditionLayout(seed: number): ExpeditionLayout {
  const rng = mulberry32(seed * 2654435761 + 97531);
  const rx0 = 10 + Math.floor(rng() * 2); // 10..11
  const rx1 = rx0 + 1;
  const detourTop = rng() < 0.5;
  const ridgeTop = detourTop ? 2 : 0;
  const ridgeBottom = detourTop ? EXP_H - 1 : EXP_H - 3;
  // pass in the half away from the detour, away from the camp's mid line
  const passY = detourTop ? 9 + Math.floor(rng() * 4) : 2 + Math.floor(rng() * 4); // 9..12 | 2..5
  const camp = { x: 1, y: 7 };
  const crateYs = [4, 6, 8, 10];
  for (let i = crateYs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [crateYs[i], crateYs[j]] = [crateYs[j], crateYs[i]];
  }
  const crates = crateYs.map((y, i) => ({
    id: `crate-${i}`,
    home: { x: 21 + (i % 2), y: Math.max(1, Math.min(EXP_H - 2, y)) },
  }));
  const spawns = [0, 1, 2, 3].map((i) => ({ x: 2 + (i % 2), y: 5 + i }));
  return { rx0, rx1, ridgeTop, ridgeBottom, passY, detourTop, camp, crates, spawns };
}

export class Expedition {
  members: Member[] = [];
  crates: Crate[] = [];
  t = 0;
  elapsed = 0;
  speed = 1;
  paused = false;
  status: "running" | "complete" | "failed" = "running";
  failureReason: string | null = null;
  sharingAllowed = true;
  log: FeedLine[] = [];
  readonly seed: number;
  readonly layout: ExpeditionLayout;
  private rng: () => number;
  private controller: ExpeditionController | null = null;
  private dispatchT = 0;
  // Knowledge: who found the pass themselves, and whether it was shared.
  private discovered = new Set<string>(); // member ids with private knowledge
  private discoveries: { by: string; name: string; t: number }[] = [];
  private shared: { by: string; name: string; t: number } | null = null;
  private routeUpdates: { member: string; name: string; via: string; t: number }[] = [];
  private routeCredited = new Set<string>(); // members already credited a route update
  // Tiles each member has physically visited (drives "unscouted" targets).
  private visited = new Map<string, Set<string>>();

  constructor(crew: CrewMember[], seed = 7) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.layout = generateExpeditionLayout(seed);
    this.members = crew.slice(0, 4).map((c, i) => ({
      ...c,
      pos: center(this.layout.spawns[i % this.layout.spawns.length]),
      path: [],
      state: "idle",
      crate: null,
      bubble: null,
      bubbleUntil: 0,
      wanderT: 1 + i * 0.7,
    }));
    this.crates = this.layout.crates.map((c) => ({
      ...c, pos: center(c.home), claimedBy: null, delivered: false,
    }));
    for (const m of this.members) this.markVisited(m);
  }

  setController(c: ExpeditionController | null) { this.controller = c; }
  setSharing(on: boolean) { this.sharingAllowed = on; }

  deliveredCount(): number { return this.crates.filter((c) => c.delivered).length; }

  private member(id: string | null): Member | undefined { return this.members.find((m) => m.id === id); }
  private free(m: Member): boolean { return m.state === "idle" || m.state === "wandering"; }

  knowsPass(memberId: string): boolean {
    return this.shared !== null || this.discovered.has(memberId);
  }

  private isRidge(xi: number, yi: number): boolean {
    const l = this.layout;
    return xi >= l.rx0 && xi <= l.rx1 && yi >= l.ridgeTop && yi <= l.ridgeBottom;
  }

  private isPassTile(xi: number, yi: number): boolean {
    return this.isRidge(xi, yi) && yi === this.layout.passY;
  }

  walkableFor(memberId: string | null, x: number, y: number): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= EXP_W || yi >= EXP_H) return false;
    if (!this.isRidge(xi, yi)) return true;
    if (!this.isPassTile(xi, yi)) return false;
    return memberId !== null && this.knowsPass(memberId);
  }

  pathFor(memberId: string | null, from: Vec, to: Vec): Vec[] | null {
    const s = { x: Math.floor(from.x), y: Math.floor(from.y) };
    const g = { x: Math.floor(to.x), y: Math.floor(to.y) };
    if (!this.walkableFor(memberId, g.x + 0.5, g.y + 0.5)) return null;
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
        if (seen.has(nk) || !this.walkableFor(memberId, nx + 0.5, ny + 0.5)) continue;
        seen.add(nk); prev.set(nk, key(c.x, c.y)); q.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  private pathLen(memberId: string | null, from: Vec, to: Vec): number | null {
    const p = this.pathFor(memberId, from, to);
    if (!p) return null;
    let len = 0;
    let cur = from;
    for (const n of p) { len += dist(cur, n); cur = n; }
    return Math.round(len);
  }

  private pathUsesPass(path: Vec[]): boolean {
    return path.some((p) => this.isPassTile(Math.floor(p.x), Math.floor(p.y)));
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

  // Ridge-front tiles this mii could still inspect: walkable tiles adjacent
  // to the ridge on the mii's side of it, not already visited up close.
  private scoutTargets(m: Member): Vec[] {
    const west = m.pos.x < this.layout.rx0;
    const out: Vec[] = [];
    const seen = this.visited.get(m.id) ?? new Set<string>();
    for (let y = this.layout.ridgeTop; y <= this.layout.ridgeBottom; y++) {
      const x = west ? this.layout.rx0 - 1 : this.layout.rx1 + 1;
      if (x < 0 || x >= EXP_W) continue;
      if (!this.walkableFor(m.id, x + 0.5, y + 0.5)) continue;
      const nearSeen = [...seen].some((k) => {
        const [vx, vy] = k.split(",").map(Number);
        return Math.abs(vx - x) <= 1 && Math.abs(vy - y) <= 2;
      });
      if (!nearSeen) out.push({ x, y });
    }
    return out;
  }

  canScout(memberId: string): boolean {
    const m = this.member(memberId);
    if (!m || this.knowsPass(memberId)) return false;
    return this.scoutTargets(m).length > 0;
  }

  // What the shared board shows every mii: public claims and shares only.
  // Private discoveries are NOT on the board until shared.
  private announcements(): string[] {
    const out: string[] = [];
    for (const c of this.crates) {
      if (c.claimedBy && !c.delivered) {
        const m = this.member(c.claimedBy);
        if (m) out.push(`${m.name} is ${m.state === "carrying" ? "carrying" : "fetching"} ${c.id}.`);
      }
    }
    if (this.shared) {
      out.push(`${this.shared.name} shared a hidden pass through the ridge at (${this.layout.rx0},${this.layout.passY}).`);
    }
    return out;
  }

  decisionViewFor(memberId: string): MemberView {
    const m = this.member(memberId)!;
    const iKnow = this.knowsPass(memberId);
    const iDiscovered = this.discovered.has(memberId);
    return {
      me: { id: m.id, name: m.name, x: m.pos.x, y: m.pos.y, carrying: m.state === "carrying" },
      others: this.members.filter((o) => o.id !== m.id)
        .map((o) => ({ id: o.id, name: o.name, free: this.free(o), x: o.pos.x, y: o.pos.y })),
      delivered: this.deliveredCount(),
      total: this.crates.length,
      crates: this.crates.map((c) => {
        const carrier = this.members.find((o) => o.state === "carrying" && o.crate === c.id);
        return {
          id: c.id,
          // a crate on the move sits where its carrier walks - printing those
          // coordinates would leak a private route (e.g. the unshared pass)
          x: carrier ? null : c.pos.x, y: carrier ? null : c.pos.y,
          claimedBy: c.claimedBy, delivered: c.delivered,
          carriedBy: carrier ? carrier.name : null,
          routeTiles: c.delivered || carrier ? null : this.pathLen(memberId, m.pos, c.pos),
        };
      }),
      camp: this.layout.camp,
      detour: { x: this.layout.rx0, y: this.layout.detourTop ? 0 : EXP_H - 1 },
      passIKnow: iKnow
        ? { x: this.layout.rx0, y: this.layout.passY, foundBy: iDiscovered ? "me" : this.shared!.name }
        : null,
      iFoundUnshared: iDiscovered && !this.shared ? { x: this.layout.rx0, y: this.layout.passY } : null,
      canScout: this.canScout(memberId),
      sharingAllowed: this.sharingAllowed,
      announcements: this.announcements(),
    };
  }

  // ---- decisions ----

  applyDecision(memberId: string, d: ExpeditionDecision): { ok: boolean; why?: string } {
    const m = this.member(memberId);
    if (!m || !this.free(m)) return { ok: false, why: "not free" };
    if (d.action === "wait") return { ok: true };
    if (d.action === "fetch") {
      const c = this.crates.find((q) => q.id === d.crate);
      if (!c) return { ok: false, why: `no such crate (${String(d.crate)})` };
      if (c.delivered || c.claimedBy) return { ok: false, why: `${c.id} is already taken` };
      const path = this.pathFor(m.id, m.pos, c.pos);
      if (!path) return { ok: false, why: `no route to ${c.id} with what ${m.name} knows` };
      c.claimedBy = m.id;
      m.state = "fetching"; m.crate = c.id; m.path = path;
      this.say(m.name, `set out for ${c.id}.`, m);
      return { ok: true };
    }
    if (d.action === "scout") {
      if (this.knowsPass(m.id)) return { ok: false, why: "already knows the pass - nothing to scout" };
      const targets = this.scoutTargets(m);
      if (!targets.length) return { ok: false, why: "the whole ridge face here is already scouted" };
      targets.sort((a, b) => dist(m.pos, center(a)) - dist(m.pos, center(b)));
      const target = targets[0];
      const path = this.pathFor(m.id, m.pos, center(target));
      if (!path) return { ok: false, why: "cannot reach the ridge face" };
      m.state = "scouting"; m.crate = null; m.path = path;
      this.say(m.name, "went to scout the ridge for a shorter way.", m);
      return { ok: true };
    }
    if (d.action === "share") {
      if (!this.sharingAllowed) return { ok: false, why: "sharing is off for this run" };
      if (!this.discovered.has(m.id)) return { ok: false, why: "has no discovery of its own to share" };
      if (this.shared) return { ok: false, why: "the crew already knows" };
      this.shared = { by: m.id, name: m.name, t: this.elapsed };
      this.say(m.name, `shared the hidden pass at (${this.layout.rx0},${this.layout.passY}) with the crew - everyone can use it now.`, m);
      this.replanAfterShare(m.id);
      return { ok: true };
    }
    return { ok: false, why: `unknown action ${String(d.action)}` };
  }

  // After a share, every ACTIVE fetcher/carrier re-plans with the new crew
  // knowledge. This is automatic route re-planning - the feed credits the
  // share and says so, never that the other mii reasoned out the pass.
  private replanAfterShare(sharerId: string) {
    const sharer = this.member(sharerId);
    for (const m of this.members) {
      if (m.id === sharerId) continue;
      if (m.state !== "fetching" && m.state !== "carrying") continue;
      const goal = m.state === "fetching"
        ? this.crates.find((c) => c.id === m.crate)?.pos
        : center(this.layout.camp);
      if (!goal) continue;
      const path = this.pathFor(m.id, m.pos, goal);
      if (!path) continue;
      const usedPass = this.pathUsesPass(path);
      m.path = path;
      if (usedPass && !this.discovered.has(m.id) && !this.routeCredited.has(m.id)) {
        this.routeCredited.add(m.id);
        this.routeUpdates.push({ member: m.id, name: m.name, via: sharer?.name ?? "the crew", t: this.elapsed });
        this.say(m.name, `route automatically updated - it now goes through the pass ${sharer?.name} shared.`);
      }
    }
  }

  // Discovery: only while SCOUTING (looking), within sight of a pass tile.
  private checkDiscovery(m: Member) {
    if (m.state !== "scouting" || this.discovered.has(m.id)) return;
    for (const rx of [this.layout.rx0, this.layout.rx1]) {
      const tile = center({ x: rx, y: this.layout.passY });
      if (dist(m.pos, tile) <= SIGHT) {
        this.discovered.add(m.id);
        this.discoveries.push({ by: m.id, name: m.name, t: this.elapsed });
        m.path = [];
        m.state = "idle"; // stop and re-decide with the new knowledge
        this.say(m.name, `found a hidden pass through the ridge at (${this.layout.rx0},${this.layout.passY})! Only ${m.name} knows.${this.shared ? "" : this.sharingAllowed ? "" : " (sharing is off this run)"}`, m);
        return;
      }
    }
  }

  private builtin(m: Member) {
    // Built-in assigner: nearest reachable crate with PUBLIC knowledge only
    // (crew shares count - they are public once shared). Never scouts, never
    // shares: with no model connected the crew simply takes the long way.
    let best: { c: Crate; len: number; path: Vec[] } | null = null;
    for (const c of this.crates) {
      if (c.delivered || c.claimedBy) continue;
      const path = this.pathFor(m.id, m.pos, c.pos);
      if (!path) continue;
      const len = this.pathLen(m.id, m.pos, c.pos)!;
      if (!best || len < best.len) best = { c, len, path };
    }
    if (best) {
      best.c.claimedBy = m.id;
      m.state = "fetching"; m.crate = best.c.id; m.path = best.path;
      this.say(m.name, `set out for ${best.c.id}.`, m);
    }
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
      if (!this.free(m)) continue;
      if (!this.controller) { this.builtin(m); continue; }
      const out = this.controller.decide(this.decisionViewFor(m.id));
      if (out === "pending") continue;
      if (out === "fallback") { this.builtin(m); continue; }
      const res = this.applyDecision(m.id, out);
      if (res.ok) this.controller.applied?.(m.id, out);
      else this.controller.rejected?.(m.id, out, res.why ?? "rejected");
    }
    // the wall may have been hit mid-round: latch BEFORE any further advance
    if (this.controller?.budgetExhausted?.()) this.failBudget();
  }

  private step(m: Member, dt: number): boolean {
    let budget = BASE_SPEED * this.speed * dt;
    while (budget > 0 && m.path.length) {
      const next = m.path[0];
      const d = dist(m.pos, next);
      if (d <= budget) { m.pos = next; m.path.shift(); budget -= d; this.markVisited(m); }
      else {
        m.pos = { x: m.pos.x + ((next.x - m.pos.x) / d) * budget, y: m.pos.y + ((next.y - m.pos.y) / d) * budget };
        budget = 0;
      }
    }
    return m.path.length === 0;
  }

  private complete() {
    this.status = "complete";
    for (const m of this.members) { m.state = "celebrating"; m.path = []; m.crate = null; }
    this.say("Puzzle", "All supplies delivered - the crew did it!");
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
      switch (m.state) {
        case "idle": {
          m.wanderT -= dt * this.speed;
          if (m.wanderT <= 0) {
            m.wanderT = 2 + this.rng() * 3;
            const spot = { x: 1 + this.rng() * Math.max(1, this.layout.rx0 - 4), y: 1 + this.rng() * (EXP_H - 2) };
            const path = this.pathFor(m.id, m.pos, { x: Math.floor(spot.x) + 0.5, y: Math.floor(spot.y) + 0.5 });
            if (path) { m.path = path; m.state = "wandering"; }
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
        case "fetching": {
          const c = this.crates.find((q) => q.id === m.crate);
          if (!c || c.delivered) { m.state = "idle"; m.crate = null; break; }
          if (this.step(m, dt) || dist(m.pos, c.pos) < PICKUP_DIST) {
            m.state = "carrying";
            c.pos = { ...m.pos };
            const back = this.pathFor(m.id, m.pos, center(this.layout.camp));
            m.path = back ?? [];
            this.say(m.name, `picked up ${c.id} - heading back to camp.`, m);
          }
          break;
        }
        case "carrying": {
          const c = this.crates.find((q) => q.id === m.crate);
          if (c) c.pos = { ...m.pos };
          if (this.step(m, dt) || dist(m.pos, center(this.layout.camp)) < DELIVER_DIST) {
            if (c) { c.delivered = true; c.pos = center(this.layout.camp); }
            m.state = "idle"; m.crate = null;
            this.say(m.name, `delivered ${c?.id ?? "a crate"} to camp (${this.deliveredCount()}/${this.crates.length}).`, m);
            if (this.deliveredCount() === this.crates.length) this.complete();
          }
          break;
        }
        case "celebrating": break;
      }
    }
  }

  snapshot(): ExpeditionSnapshot {
    return {
      t: this.t,
      elapsed: this.elapsed,
      status: this.status,
      failureReason: this.failureReason,
      paused: this.paused,
      speed: this.speed,
      seed: this.seed,
      ridge: { rx0: this.layout.rx0, rx1: this.layout.rx1, top: this.layout.ridgeTop, bottom: this.layout.ridgeBottom },
      pass: {
        y: this.layout.passY,
        foundByAnyone: this.discovered.size > 0 || this.shared !== null,
        sharedBy: this.shared?.name ?? null,
        knownBy: this.members.filter((m) => this.knowsPass(m.id)).map((m) => m.name),
      },
      camp: this.layout.camp,
      members: this.members.map((m) => ({
        id: m.id, name: m.name, color: m.color,
        x: m.pos.x, y: m.pos.y, state: m.state,
        carrying: m.state === "carrying", bubble: m.bubble,
        path: m.path.map((p) => ({ ...p })),
      })),
      crates: this.crates.map((c) => ({
        id: c.id, x: c.pos.x, y: c.pos.y, claimedBy: c.claimedBy, delivered: c.delivered,
      })),
      delivered: this.deliveredCount(),
      total: this.crates.length,
      sharingAllowed: this.sharingAllowed,
      log: this.log.slice(-60),
      stats: {
        discoveries: [...this.discoveries],
        shares: this.shared ? [this.shared] : [],
        routeUpdates: [...this.routeUpdates],
      },
    };
  }
}
