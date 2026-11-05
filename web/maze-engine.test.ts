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
  p.jailer.active = false; // door physics only: no interruptions
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
  p.jailer.active = false; // door queueing only: no interruptions
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

test("shared board: cache activity is visible only to crack-knowers until a share", () => {
  const seed = seedWithCrack();
  const scoutOut = (p: Maze, id: string) => {
    const m = p.members.find((x) => x.id === id)!;
    let found = false;
    for (let trip = 0; trip < 10 && !found; trip++) {
      p.applyDecision(id, { action: "scout", reason: "" });
      let t = 0;
      while (t < 90 && m.state === "scouting") { p.tick(0.05); t += 0.05; }
      found = p.decisionViewFor(id).iFoundUnshared !== null;
    }
    assert.ok(found, "scouting found the crack");
  };
  // private run: the discoverer fetches the cache WITHOUT sharing
  const p = new Maze(CREW, seed);
  p.setController(WAITER);
  scoutOut(p, "a");
  assert.ok(p.applyDecision("b", { action: "hold", plate: "plate-0", reason: "" }).ok);
  assert.ok(p.applyDecision("a", { action: "fetch", crate: "cache-0", reason: "" }).ok);
  const boardB = p.decisionViewFor("b").announcements.join("\n");
  assert.ok(boardB.includes("Marlo is heading to plate-0"), "public activity still on the board");
  assert.ok(!/cache/i.test(boardB), "non-knower board must not mention the cache or its finder");
  assert.ok(!/cache/i.test(p.decisionViewFor("c").announcements.join("\n")), "no cache leak to any non-knower");
  assert.ok(p.decisionViewFor("a").announcements.join("\n").includes("Pip is fetching cache-0"),
    "the discoverer still sees their own cache line");
  // shared run: after a share, cache activity is legitimately public
  const p2 = new Maze(CREW, seed);
  p2.setController(WAITER);
  scoutOut(p2, "a");
  assert.ok(p2.applyDecision("a", { action: "share", reason: "" }).ok);
  assert.ok(p2.applyDecision("a", { action: "fetch", crate: "cache-0", reason: "" }).ok);
  assert.ok(p2.decisionViewFor("b").announcements.join("\n").includes("cache-0"),
    "after a share the cache line is public");
});

// ---- the jailer ----

// A cell a few steps down a straight carved corridor from a position (the
// jailer's line of sight runs along corridors).
function lineSpot(p: Maze, from: { x: number; y: number }, maxSteps: number): { x: number; y: number } | null {
  const carved = new Set(p.layout.carved);
  const ek = (ax: number, ay: number, bx: number, by: number) =>
    ax < bx || (ax === bx && ay <= by) ? `${ax},${ay}|${bx},${by}` : `${bx},${by}|${ax},${ay}`;
  const fc = { x: Math.floor(from.x), y: Math.floor(from.y) };
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let x = fc.x, y = fc.y;
    for (let i = 0; i < maxSteps; i++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H || !carved.has(ek(x, y, nx, ny))) break;
      x = nx; y = ny;
    }
    if (x !== fc.x || y !== fc.y) return { x, y };
  }
  return null;
}

test("layout: the jail is a camp-side dead end and the post sits mid completion path", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const l = generateMazeLayout(seed);
    assert.ok(l.jail && l.jailerPost, `seed ${seed} has a jail and a jailer post`);
    // the jail is reachable on the camp side with the door shut
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
    assert.ok(reach.has(l.jail.x + "," + l.jail.y), `seed ${seed} jail reachable on the camp side`);
    assert.ok(!(l.jail.x === l.camp.x && l.jail.y === l.camp.y), `seed ${seed} jail is not the camp`);
    // the post is on the camp-to-farthest-crate route (the completion path)
    const open = new Set(l.carved);
    const prev = new Map<string, string>();
    const dDoor = new Map<string, number>();
    {
      const dq = [{ x: l.door.bx, y: l.door.by }];
      dDoor.set(l.door.bx + "," + l.door.by, 0);
      while (dq.length) {
        const c = dq.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = c.x + dx, ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
          const nk = nx + "," + ny;
          const ek = c.x < nx || (c.x === nx && c.y <= ny) ? `${c.x},${c.y}|${nx},${ny}` : `${nx},${ny}|${c.x},${c.y}`;
          if (dDoor.has(nk) || !open.has(ek)) continue;
          dDoor.set(nk, dDoor.get(c.x + "," + c.y)! + 1); dq.push({ x: nx, y: ny });
        }
      }
    }
    const far = l.crates.reduce((a, b) =>
      (dDoor.get(b.home.x + "," + b.home.y) ?? 0) >= (dDoor.get(a.home.x + "," + a.home.y) ?? 0) ? b : a);
    const qq = [{ x: l.camp.x, y: l.camp.y }];
    const seen = new Set([l.camp.x + "," + l.camp.y]);
    const route: string[] = [];
    while (qq.length) {
      const c = qq.shift()!;
      if (c.x === far.home.x && c.y === far.home.y) {
        let k = c.x + "," + c.y;
        while (k !== l.camp.x + "," + l.camp.y) { route.unshift(k); k = prev.get(k)!; }
        break;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= MAZE_W || ny >= MAZE_H) continue;
        const nk = nx + "," + ny;
        const ek = c.x < nx || (c.x === nx && c.y <= ny) ? `${c.x},${c.y}|${nx},${ny}` : `${nx},${ny}|${c.x},${c.y}`;
        if (seen.has(nk) || !open.has(ek)) continue;
        seen.add(nk); prev.set(nk, c.x + "," + c.y); qq.push({ x: nx, y: ny });
      }
    }
    assert.ok(route.includes(l.jailerPost.x + "," + l.jailerPost.y), `seed ${seed} post on the completion path`);
  }
});

test("jailer: wanders near its post while nobody is in sight", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  for (const m of p.members) {
    m.wanderT = 9999;
    m.pos = { x: p.layout.camp.x + 0.5, y: p.layout.camp.y + 0.5 }; // out of sight at camp
  }
  const post = p.jailer.post;
  let moved = 0;
  for (let t = 0; t < 90; t += 0.05) {
    p.tick(0.05);
    moved = Math.max(moved, Math.hypot(p.jailer.pos.x - post.x, p.jailer.pos.y - post.y));
    // wander TARGETS sit within a small radius of the post; in a perfect maze
    // the path between two nearby cells can wind, so allow corridor detours
    assert.ok(
      Math.hypot(p.jailer.pos.x - post.x, p.jailer.pos.y - post.y) <= 10,
      `jailer stays near its post (drifted to ${p.jailer.pos.x.toFixed(1)},${p.jailer.pos.y.toFixed(1)} from ${post.x},${post.y})`,
    );
  }
  assert.ok(moved > 0.5, "the jailer actually wanders");
});

test("jailer: chases a mii in its line of sight, jails it, despawns and leaves a reachable key", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const a = p.members[0];
  a.wanderT = 9999;
  const spot = lineSpot(p, p.jailer.pos, 3)!;
  a.pos = { x: spot.x + 0.5, y: spot.y + 0.5 };
  let t = 0;
  while (t < 40 && a.state !== "jailed") { p.tick(0.05); t += 0.05; }
  assert.equal(a.state, "jailed", "the mii in sight is caught");
  assert.equal(p.jailer.active, false, "the jailer despawns on a capture");
  assert.equal(a.pos.x, p.layout.jail.x + 0.5);
  assert.equal(a.pos.y, p.layout.jail.y + 0.5);
  assert.ok(p.log.some((l) => l.text.includes("was caught by the jailer")), "the feed reports the capture");
  assert.ok(p.key, "a jail key appears");
  const backHome = p.pathFor(null, p.key!.pos, { x: p.layout.camp.x + 0.5, y: p.layout.camp.y + 0.5 });
  assert.ok(backHome, "the key is reachable");
  // one captive at a time: nobody else is hunted while the jailer is gone
  const b = p.members[1];
  b.wanderT = 9999;
  b.pos = { x: p.jailer.pos.x, y: p.jailer.pos.y };
  for (let t2 = 0; t2 < 5; t2 += 0.05) p.tick(0.05);
  assert.notEqual(b.state, "jailed", "no second capture while a captive sits in jail");
});

test("jailer: a freed captive brings the jailer back, and the crew then avoids it", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const [a, b] = p.members;
  a.wanderT = 9999;
  const spot = lineSpot(p, p.jailer.pos, 3)!;
  a.pos = { x: spot.x + 0.5, y: spot.y + 0.5 };
  let t = 0;
  while (t < 40 && a.state !== "jailed") { p.tick(0.05); t += 0.05; }
  assert.equal(a.state, "jailed");
  // a crewmate fetches the key and frees the captive
  const r = p.applyDecision(b.id, { action: "rescue", reason: "freeing" });
  assert.ok(r.ok, r.why);
  t = 0;
  while (t < 300 && a.state === "jailed") { p.tick(0.05); t += 0.05; }
  assert.notEqual(a.state, "jailed", "the captive is freed");
  assert.equal(p.key, null, "the key is used up");
  assert.equal(p.jailer.active, true, "the jailer respawns");
  // respawns far from the crew and re-posts there instead of returning to
  // the middle beside the rescue
  const spot2r = p.respawnSpot();
  assert.ok(Math.hypot(p.jailer.pos.x - (spot2r.x + 0.5), p.jailer.pos.y - (spot2r.y + 0.5)) < 1, "respawns at the farthest reachable cell from the crew and its remaining work");
  assert.ok(Math.hypot(p.jailer.pos.x - p.jailer.post.x, p.jailer.pos.y - p.jailer.post.y) < 1, "re-posts at the far respawn cell");
  assert.ok(Math.hypot(p.jailer.post.x - p.layout.jailerPost.x, p.jailer.post.y - p.layout.jailerPost.y) >= 4, "the new post is far from the original midpoint post");
  assert.ok(p.log.some((l) => l.text.includes("far from the crew")), "the feed reports the far respawn");
  // now the crew knows: a chased mii drops everything and runs
  b.wanderT = 9999;
  b.state = "idle" as typeof b.state; b.path = [];
  const spot2 = lineSpot(p, p.jailer.pos, 3)!;
  b.pos = { x: spot2.x + 0.5, y: spot2.y + 0.5 };
  let fled = false;
  t = 0;
  while (t < 40 && b.state !== "jailed" && !fled) {
    p.tick(0.05); t += 0.05;
    if (b.state === "fleeing") fled = true;
  }
  assert.ok(fled, "after the first capture a chased mii flees");
});

test("jailer: the built-in crew completes the maze without freeing a captive", () => {
  const p = new Maze(CREW, 7);
  const a = p.members[0];
  // jail someone immediately and throw the key away: no rescue is possible
  a.wanderT = 9999;
  const spot = lineSpot(p, p.jailer.pos, 3)!;
  a.pos = { x: spot.x + 0.5, y: spot.y + 0.5 };
  let t = 0;
  while (t < 40 && a.state !== "jailed") { p.tick(0.05); t += 0.05; }
  assert.equal(a.state, "jailed");
  p.key = null;
  run(p);
  assert.equal(p.status, "complete", "the crew finishes with a captive in jail");
  assert.equal(p.snapshot().captiveId, a.id, "the captive was left behind");
});

test("jailer: a holder-capture never deadlocks the door (regression: seeds 237, 351, 355, 576, 630, 798)", () => {
  // the jailer can catch a plate holder while every other free mii is
  // warrens-side: a camp-side crewmate must release a plate, fetch the
  // camp-side key and free the captive so the plates can be manned again
  for (const seed of [237, 351, 355, 576, 630, 798]) {
    const p = new Maze(CREW, seed);
    const t = run(p, 2400);
    assert.equal(p.status, "complete", `seed ${seed} deadlocked at ${t}s with ${p.deliveredCount()}/4 (${p.failureReason ?? ""})`);
  }
});

test("jailer: rescue requires a captive and a free key", () => {
  const p = new Maze(CREW, 7);
  p.setController(WAITER);
  const [a, b, c] = p.members;
  let r = p.applyDecision(b.id, { action: "rescue", reason: "nobody is jailed" });
  assert.equal(r.ok, false, "no captive - nothing to rescue");
  a.wanderT = 9999;
  const spot = lineSpot(p, p.jailer.pos, 3)!;
  a.pos = { x: spot.x + 0.5, y: spot.y + 0.5 };
  let t = 0;
  while (t < 40 && a.state !== "jailed") { p.tick(0.05); t += 0.05; }
  assert.equal(a.state, "jailed");
  r = p.applyDecision(b.id, { action: "rescue", reason: "freeing" });
  assert.ok(r.ok, r.why);
  r = p.applyDecision(c.id, { action: "rescue", reason: "also freeing" });
  assert.equal(r.ok, false, "one rescuer claims the key");
});
