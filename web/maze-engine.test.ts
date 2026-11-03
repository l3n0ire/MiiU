import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Maze, generateMazeLayout, verifyMazeLayout, MAZE_W, MAZE_H,
  type CrewMember,
} from "./maze-engine.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

// A controller that always waits: keeps dispatch from running the built-in
// assigner, so unit tests can drive members by hand.
const WAITER = { decide: () => ({ action: "wait" as const, reason: "" }) };

function run(p: Maze, maxSeconds = 1200): number {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status === "running") { p.tick(dt); t += dt; }
  return t;
}

test("layout: solvability-checked, split by the door, plates near it, crates sealed behind it", () => {
  let cracks = 0;
  const fingerprints = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const l = generateMazeLayout(seed);
    assert.ok(verifyMazeLayout(l), `seed ${seed} passes the solvability check`);
    assert.equal(l.plates.length, 2, `seed ${seed} two plates`);
    assert.equal(l.crates.length, 4, `seed ${seed} four crates`);
    assert.equal(l.spawns.length, 4, `seed ${seed} four spawns`);
    // door is a real edge of the maze
    assert.ok(l.carved.some((k) => {
      const [a, b] = k.split("|");
      return a === `${l.door.ax},${l.door.ay}` && b === `${l.door.bx},${l.door.by}`;
    }), `seed ${seed} door edge exists in the maze`);
    // plates, spawns and camp are on the camp side; crates are sealed behind
    // the door (reachability regions, checked with the door edge removed)
    const shut = new Set(l.carved.filter((k) => {
      const [a, b] = k.split("|");
      return !(a === `${l.door.ax},${l.door.ay}` && b === `${l.door.bx},${l.door.by}`);
    }));
    const reach = new Set<string>([l.camp.x + "," + l.camp.y]);
    const q = [l.camp];
    while (q.length) {
      const c = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
        const nk = nx + "," + ny;
        const ek = c.x < nx || (c.x === nx && c.y <= ny) ? `${c.x},${c.y}|${nx},${ny}` : `${nx},${ny}|${c.x},${c.y}`;
        if (reach.has(nk) || !shut.has(ek)) continue;
        reach.add(nk); q.push({ x: nx, y: ny });
      }
    }
    for (const p of l.plates) assert.ok(reach.has(p.pos.x + "," + p.pos.y), `seed ${seed} ${p.id} on the camp side`);
    for (const s of l.spawns) assert.ok(reach.has(s.x + "," + s.y), `seed ${seed} spawn on the camp side`);
    for (const c of l.crates) assert.ok(!reach.has(c.home.x + "," + c.home.y), `seed ${seed} ${c.id} sealed behind the door`);
    if (l.crack) {
      cracks++;
      assert.ok(l.chamber && l.cache, `seed ${seed} crack implies chamber+cache`);
      assert.ok(!l.carved.some((k) => {
        const [a, b] = k.split("|");
        return a === `${l.crack!.ax},${l.crack!.ay}` && b === `${l.crack!.bx},${l.crack!.by}`;
      }), `seed ${seed} crack edge is NOT carved (hidden)`);
    }
    fingerprints.add(JSON.stringify([l.carved, l.door, l.plates, l.camp, l.crates, l.crack]));
  }
  assert.ok(cracks >= 15, `most layouts have a hidden crack (got ${cracks}/60)`);
  assert.ok(cracks <= 55, `some layouts have no crack (got ${cracks}/60)`);
  assert.ok(fingerprints.size >= 55, `layouts vary across seeds (${fingerprints.size}/60 distinct)`);
  assert.deepEqual(generateMazeLayout(99), generateMazeLayout(99), "deterministic");
});

test("door physics: shut until BOTH plates are held, shuts again on release", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const [a, b] = p.members;
  assert.equal(p.doorOpen(), false);
  const l = p.layout;
  // nobody can path east while the door is shut (movement view), but plans
  // are laid THROUGH the door so carriers queue at it
  const plan = p.pathFor(a.id, a.pos, { x: l.crates[0].home.x + 0.5, y: l.crates[0].home.y + 0.5 });
  assert.ok(plan, "a planned route through the door exists");
  // hold plate-0 only
  let r = p.applyDecision(a.id, { action: "hold", plate: "plate-0", reason: "holding" });
  assert.ok(r.ok, r.why);
  let t = 0;
  while (t < 60 && a.state !== "holding") { p.tick(0.05); t += 0.05; }
  assert.equal(a.state, "holding");
  assert.equal(p.doorOpen(), false, "one plate is not enough");
  // second holder opens it
  r = p.applyDecision(b.id, { action: "hold", plate: "plate-1", reason: "holding" });
  assert.ok(r.ok, r.why);
  t = 0;
  while (t < 60 && b.state !== "holding") { p.tick(0.05); t += 0.05; }
  assert.equal(p.doorOpen(), true);
  assert.ok(p.log.some((x) => x.text.includes("door rumbles open")), "feed says the door opened");
  // release: door shuts
  r = p.applyDecision(a.id, { action: "release", reason: "leaving" });
  assert.ok(r.ok, r.why);
  assert.equal(p.doorOpen(), false);
  assert.ok(p.log.some((x) => x.text.includes("door grinds shut")), "feed says the door shut");
});

test("a carrier mid-trip waits at the shut door and continues when it reopens", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const [a, b, c] = p.members;
  // holders in place
  p.applyDecision(a.id, { action: "hold", plate: "plate-0", reason: "" });
  p.applyDecision(b.id, { action: "hold", plate: "plate-1", reason: "" });
  let t = 0;
  while (t < 90 && !p.doorOpen()) { p.tick(0.05); t += 0.05; }
  assert.ok(p.doorOpen(), "door opened by two holders");
  // Gus? no - third member fetches
  const r = p.applyDecision(c.id, { action: "fetch", crate: "crate-0", reason: "" });
  assert.ok(r.ok, r.why);
  // let it cross into the warrens and pick up the crate
  t = 0;
  while (t < 120 && c.state !== "carrying") { p.tick(0.05); t += 0.05; }
  assert.equal(c.state, "carrying", "crate picked up");
  // slam the door on its return leg
  const before = { ...c.pos };
  p.applyDecision(a.id, { action: "release", reason: "" });
  assert.equal(p.doorOpen(), false);
  let moved = 0;
  for (let i = 0; i < 200; i++) { // 10s with the door shut
    p.tick(0.05);
    moved = Math.max(moved, Math.hypot(c.pos.x - before.x, c.pos.y - before.y));
  }
  assert.equal(c.state, "carrying", "still carrying, undelivered");
  assert.ok(p.deliveredCount() === 0, "nothing delivered while the door was shut");
  // reopen: delivery completes
  p.applyDecision(a.id, { action: "hold", plate: "plate-0", reason: "" });
  t = 0;
  while (t < 120 && p.deliveredCount() === 0) { p.tick(0.05); t += 0.05; }
  assert.equal(p.deliveredCount(), 1, "delivered once the door reopened");
});

test("built-in crew completes with code-driven cooperation and never scouts or shares", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const p = new Maze(CREW, seed);
    const t = run(p);
    assert.equal(p.status, "complete", `seed ${seed} stalled at ${t}s with ${p.deliveredCount()}/4 (${p.failureReason ?? ""})`);
    const s = p.snapshot();
    assert.equal(s.stats.discoveries.length, 0, `seed ${seed}: errand running accidentally found the crack`);
    assert.equal(s.stats.shares.length, 0);
    assert.equal(s.stats.cacheDeliveredBy, null, `seed ${seed}: built-in found the cache`);
  }
});

function seedWithCrack(start = 1): number {
  for (let s = start; s < start + 100; s++) if (generateMazeLayout(s).crack) return s;
  throw new Error("no cracked seed found");
}

test("scouting discovers the crack privately; sharing propagates it; the cache becomes reachable", () => {
  const seed = seedWithCrack();
  const p = new Maze(CREW, seed);
  p.setController(WAITER);
  const a = p.members[0];
  const l = p.layout;
  // nobody knows anything at the start; the crack is not walkable for anyone
  assert.equal(p.decisionViewFor(a.id).crackIKnow, null);
  assert.equal(p.decisionViewFor(a.id).cache, null);
  assert.equal(p.canScout(a.id), true);
  // scout until the crack is found
  let found = false;
  for (let trip = 0; trip < 10 && !found; trip++) {
    const res = p.applyDecision(a.id, { action: "scout", reason: "looking" });
    assert.ok(res.ok, res.why);
    let t = 0;
    while (t < 90 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
    found = p.decisionViewFor(a.id).iFoundUnshared !== null;
  }
  assert.ok(found, "scouting found the crack");
  // private: only Pip knows; the cache path exists only for him
  assert.deepEqual(p.snapshot().crack?.knownBy, ["Pip"]);
  assert.equal(p.decisionViewFor(p.members[1].id).crackIKnow, null);
  assert.equal(p.decisionViewFor(p.members[1].id).cache, null, "cache hidden from non-knowers");
  assert.ok(!p.canScout(a.id), "nothing left to scout for the discoverer");
  const cacheHome = { x: l.cache!.home.x + 0.5, y: l.cache!.home.y + 0.5 };
  assert.ok(p.pathFor(a.id, a.pos, cacheHome), "discoverer can path to the cache");
  assert.equal(p.pathFor(p.members[1].id, p.members[1].pos, cacheHome), null, "others cannot path to the cache");
  // others may NOT fetch it (engine rejects what they cannot know)
  const denied = p.applyDecision(p.members[1].id, { action: "fetch", crate: "cache-0", reason: "" });
  assert.equal(denied.ok, false, "non-knower cannot fetch the cache");
  // share: now everyone knows, credited to Pip
  const res = p.applyDecision(a.id, { action: "share", reason: "telling everyone" });
  assert.ok(res.ok, res.why);
  const s = p.snapshot();
  assert.equal(s.crack?.sharedBy, "Pip");
  assert.equal(s.crack?.knownBy.length, 4);
  assert.equal(p.decisionViewFor(p.members[1].id).crackIKnow?.foundBy, "Pip");
  assert.ok(p.decisionViewFor(p.members[1].id).cache, "cache visible after the share");
  assert.ok(s.log.some((x) => x.text.includes("shared the hidden crack")));
  // and a crewmate can actually fetch and deliver the golden crate now
  const b = p.members[1];
  const fr = p.applyDecision(b.id, { action: "fetch", crate: "cache-0", reason: "" });
  assert.ok(fr.ok, fr.why);
  let t = 0;
  while (t < 240 && !p.crates.find((c) => c.golden)!.delivered && b.state !== "idle") { p.tick(0.05); t += 0.05; }
  // (door must be held for the return leg if the route needs it; hold plates)
  if (!p.crates.find((c) => c.golden)!.delivered) {
    p.applyDecision(p.members[2].id, { action: "hold", plate: "plate-0", reason: "" });
    p.applyDecision(p.members[3].id, { action: "hold", plate: "plate-1", reason: "" });
    while (t < 400 && !p.crates.find((c) => c.golden)!.delivered) { p.tick(0.05); t += 0.05; }
  }
  assert.ok(p.crates.find((c) => c.golden)!.delivered, "golden cache crate delivered after the share");
  assert.equal(p.snapshot().stats.cacheDeliveredBy, "Marlo");
});

test("sharing OFF: share is rejected and the discovery stays private", () => {
  const seed = seedWithCrack();
  const p = new Maze(CREW, seed);
  p.setController(WAITER);
  p.setSharing(false);
  const a = p.members[0];
  let found = false;
  for (let trip = 0; trip < 10 && !found; trip++) {
    p.applyDecision(a.id, { action: "scout", reason: "" });
    let t = 0;
    while (t < 90 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
    found = p.decisionViewFor(a.id).iFoundUnshared !== null;
  }
  assert.ok(found);
  const res = p.applyDecision(a.id, { action: "share", reason: "" });
  assert.equal(res.ok, false, "share rejected while sharing is off");
  assert.equal(p.snapshot().crack?.sharedBy, null);
  assert.equal(p.snapshot().crack?.knownBy.length, 1, "still private");
});

test("decision validation: impossible moves are rejected with reasons", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const [a, b] = p.members;
  assert.equal(p.applyDecision(a.id, { action: "fetch", crate: "crate-9", reason: "" }).ok, false);
  assert.equal(p.applyDecision(a.id, { action: "fetch", crate: "cache-0", reason: "" }).ok, false, "unknown cache");
  assert.equal(p.applyDecision(a.id, { action: "hold", plate: "plate-9", reason: "" }).ok, false);
  assert.equal(p.applyDecision(a.id, { action: "release", reason: "" }).ok, false, "not holding");
  assert.equal(p.applyDecision(a.id, { action: "share", reason: "" }).ok, false, "nothing to share");
  // claimed plate cannot be double-held
  assert.ok(p.applyDecision(a.id, { action: "hold", plate: "plate-0", reason: "" }).ok);
  assert.equal(p.applyDecision(b.id, { action: "hold", plate: "plate-0", reason: "" }).ok, false, "plate taken");
  assert.ok(p.applyDecision(b.id, { action: "hold", plate: "plate-1", reason: "" }).ok, "other plate free");
});

test("budget failure: the run fails at the budget wall and freezes", () => {
  let spent = 0;
  const controller = {
    decide: () => { spent++; return { action: "wait" as const, reason: "" }; },
    budgetExhausted: () => spent >= 3,
    failed: false,
    runFailed() { this.failed = true; },
  };
  const p = new Maze(CREW, 7);
  p.setController(controller);
  let t = 0;
  while (t < 30 && p.status === "running") { p.tick(0.05); t += 0.05; }
  assert.equal(p.status, "failed");
  assert.ok(p.failureReason?.includes("budget"));
  assert.ok(controller.failed, "controller was told to freeze");
  const s = p.snapshot();
  assert.equal(s.status, "failed");
  assert.ok(s.log.some((l) => l.text.includes("failed to accomplish the task")));
  // late decisions are refused
  assert.equal(p.applyDecision(p.members[0].id, { action: "wait", reason: "" }).ok, false);
});
