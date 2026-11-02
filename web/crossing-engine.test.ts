import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LongCrossing, generateCrossLayout, CROSS_W, CROSS_H,
  type CrewMember, type CrewController,
} from "./crossing-engine.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

function run(p: LongCrossing, maxSeconds = 600): number {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status !== "complete") { p.tick(dt); t += dt; }
  return t;
}

test("layout: two rivers, an island, six pieces, three beams, one ferry beam", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const l = generateCrossLayout(seed);
    const [r1, r2] = l.rivers;
    // rivers ordered, 3 wide each, island 2-3 wide, inside the map
    assert.ok(r1.x0 >= 5 && r1.x1 === r1.x0 + 2, `seed ${seed} river1`);
    assert.ok(r2.x0 - r1.x1 - 1 >= 2 && r2.x0 - r1.x1 - 1 <= 3, `seed ${seed} island width`);
    assert.ok(r2.x1 === r2.x0 + 2 && r2.x1 <= CROSS_W - 3, `seed ${seed} river2 in bounds`);
    assert.notEqual(r1.bridgeY, r2.bridgeY, `seed ${seed} distinct bridge rows`);
    // pieces: 6 total, 3 per bridge, 3 beams overall
    assert.equal(l.pieces.length, 6);
    assert.equal(l.pieces.filter((p) => p.bridge === 0).length, 3);
    assert.equal(l.pieces.filter((p) => p.bridge === 1).length, 3);
    assert.equal(l.pieces.filter((p) => p.heavy).length, 3);
    assert.equal(l.pieces.filter((p) => p.bridge === 0 && p.heavy).length, 1, `seed ${seed} bridge1 one beam`);
    assert.equal(l.pieces.filter((p) => p.bridge === 1 && p.heavy).length, 2, `seed ${seed} bridge2 two beams`);
    // bridge 1 pieces all start on the home bank
    for (const p of l.pieces.filter((p) => p.bridge === 0)) assert.ok(p.home.x < r1.x0, `seed ${seed} ${p.id} home bank`);
    // bridge 2: exactly one beam starts on the home bank (the ferry beam),
    // the other two pieces start on the island
    const far = l.pieces.filter((p) => p.bridge === 1);
    const ferry = far.filter((p) => p.home.x < r1.x0);
    assert.equal(ferry.length, 1, `seed ${seed} one ferry piece`);
    assert.equal(ferry[0].heavy, true, `seed ${seed} ferry piece is a beam`);
    for (const p of far.filter((p) => p !== ferry[0])) {
      assert.ok(p.home.x > r1.x1 && p.home.x < r2.x0, `seed ${seed} ${p.id} on the island`);
    }
    // targets are the gap cells of their bridge
    for (const p of l.pieces) {
      const r = l.rivers[p.bridge];
      assert.ok(p.target.x >= r.x0 && p.target.x <= r.x1 && p.target.y === r.bridgeY, `seed ${seed} ${p.id} target`);
    }
    // flag on the far bank, in bounds
    assert.ok(l.flag.x > r2.x1 && l.flag.x < CROSS_W && l.flag.y >= 0 && l.flag.y < CROSS_H, `seed ${seed} flag`);
    assert.equal(l.spawns.length, 4);
  }
});

test("far-bridge pieces are NOT placeable before bridge 1 exists", () => {
  const p = new LongCrossing(CREW, 7);
  const view = p.decisionView();
  const near = view.pieces.filter((q) => q.bridge === 0);
  const far = view.pieces.filter((q) => q.bridge === 1);
  assert.ok(near.some((q) => q.placeable), "some bridge-1 piece placeable at start");
  assert.ok(far.every((q) => !q.placeable), "no bridge-2 piece placeable at start");
});

test("a controller cannot force a far piece early - engine rejects it and falls back", () => {
  const p = new LongCrossing(CREW, 7);
  const farBeam = p.pieces.find((q) => q.bridge === 1 && q.heavy && q.home.x < p.layout.rivers[0].x0)!;
  let saw = 0;
  const greedyBad: CrewController = {
    decide() { saw++; return [{ piece: farBeam.id, lead: "a", helper: "b" }]; },
  };
  p.setController(greedyBad);
  for (let i = 0; i < 200; i++) p.tick(0.05);
  assert.ok(saw > 0, "controller was consulted");
  assert.equal(farBeam.lead === "a" && farBeam.state !== "idle", false, "illegal far claim never applied");
  assert.ok(p.pieces.some((q) => q.bridge === 0 && q.state !== "idle"), "built-in fallback started real work");
});

test("built-in logic completes the whole crossing (seed 7)", () => {
  const p = new LongCrossing(CREW, 7);
  const t = run(p);
  assert.equal(p.status, "complete", `finished in ${t}s`);
  assert.equal(p.placedCount(), 6);
  assert.equal(p.bridgePlaced(0), 3);
  assert.equal(p.bridgePlaced(1), 3);
  assert.ok(p.assists >= 3, "all three beams were team lifts");
  assert.equal(p.snapshot().crossedCount, 4);
});

test("the ferry beam is really carried across bridge 1", () => {
  const p = new LongCrossing(CREW, 11);
  const r1x1 = p.layout.rivers[0].x1;
  const ferry = p.pieces.find((q) => q.bridge === 1 && q.heavy && q.home.x < p.layout.rivers[0].x0)!;
  let crossedRiver = false;
  let t = 0;
  while (t < 600 && p.status !== "complete") {
    p.tick(0.05); t += 0.05;
    if (ferry.state === "carried" && ferry.pos.x > r1x1 + 0.5) crossedRiver = true;
  }
  assert.equal(p.status, "complete");
  assert.ok(crossedRiver, "ferry beam was carried over the first river");
});

test("no crossing phase before BOTH bridges are done", () => {
  const p = new LongCrossing(CREW, 21);
  let sawCrossingEarly = false;
  let t = 0;
  while (t < 600 && p.status !== "complete") {
    p.tick(0.05); t += 0.05;
    if (p.status === "crossing" && p.placedCount() < 6) sawCrossingEarly = true;
  }
  assert.equal(p.status, "complete");
  assert.ok(!sawCrossingEarly);
});

test("built-in logic completes across 100 seeds", () => {
  let worst = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const p = new LongCrossing(CREW, seed);
    const t = run(p);
    assert.equal(p.status, "complete", `seed ${seed} stalled at ${t}s with ${p.placedCount()}/6 placed`);
    worst = Math.max(worst, t);
  }
  assert.ok(worst < 400, `slowest completion ${worst}s`);
});

test("seeded layouts are deterministic", () => {
  const a = generateCrossLayout(99);
  const b = generateCrossLayout(99);
  assert.deepEqual(a, b);
});
