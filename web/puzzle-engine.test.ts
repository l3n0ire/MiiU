import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgePuzzle, generateLayout, type CrewMember } from "./puzzle-engine.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

function run(p: BridgePuzzle, maxSeconds: number): number {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status !== "complete") {
    p.tick(dt);
    t += dt;
  }
  return t;
}

test("generated layouts vary by seed and always force cooperation", () => {
  const layouts = [1, 2, 3, 4, 5].map(generateLayout);
  const signatures = new Set(layouts.map((l) => `${l.riverX0},${l.bridgeY},${l.pieces.map((p) => p.kind).join("")},${l.pieces.map((p) => `${p.home.x}:${p.home.y}`).join("|")}`));
  assert.ok(signatures.size > 1, "different seeds should produce different layouts");
  for (const l of layouts) {
    assert.equal(l.pieces.length, 3, "one piece per gap cell");
    assert.ok(l.pieces.some((p) => p.heavy), "at least one beam (needs two carriers)");
    assert.ok(l.pieces.some((p) => !p.heavy), "at least one block");
    assert.ok(l.flag.x > l.riverX1, "flag is on the far bank");
    for (const p of l.pieces) assert.ok(p.home.x < l.riverX0, "pieces start on the near bank");
  }
});

test("a full crew cooperates, builds the bridge and crosses, across seeds", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = new BridgePuzzle(CREW, seed);
    const t = run(p, 300);
    assert.equal(p.status, "complete", `seed ${seed} should finish, gave up at t=${t.toFixed(1)}s`);
    const s = p.snapshot();
    assert.equal(s.placedCount, 3);
    assert.ok(s.assists >= 1, `seed ${seed}: at least one two-mii beam lift`);
    assert.ok(s.bridge.every((c) => c.filled));
    assert.ok(s.members.some((m) => m.x > s.riverX1), `seed ${seed}: at least one mii crossed`);
  }
});

test("pieces are placed in bridge order, extending from the near bank", () => {
  for (const seed of [1, 7, 42]) {
    const p = new BridgePuzzle(CREW, seed);
    const order: number[] = [];
    const seen = new Set<string>();
    let t = 0;
    while (t < 300 && p.status !== "complete") {
      p.tick(0.05);
      t += 0.05;
      for (const piece of p.pieces) {
        if (piece.state === "placed" && !seen.has(piece.id)) {
          seen.add(piece.id);
          order.push(piece.target.x);
        }
      }
    }
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted, `seed ${seed}: near to far, order discovered from reachability`);
  }
});

test("a lone mii can never finish: the beam needs two carriers", () => {
  for (const seed of [1, 2, 3]) {
    const p = new BridgePuzzle([CREW[0]], seed);
    run(p, 120);
    const beams = p.pieces.filter((q) => q.heavy);
    assert.ok(beams.length >= 1);
    for (const beam of beams) {
      assert.notEqual(beam.state, "carried");
      assert.notEqual(beam.state, "placed");
    }
    assert.equal(p.status, "building", `seed ${seed}: no solo completion`);
  }
});

test("nobody crosses the river before the bridge is complete", () => {
  const p = new BridgePuzzle(CREW, 11);
  let t = 0;
  while (t < 300 && p.placedCount() < 3) {
    p.tick(0.05);
    t += 0.05;
    for (const m of p.members) {
      const onFilledBridgeCell = p.pieces.some((q) => q.state === "placed" && Math.floor(m.pos.x) === q.target.x && Math.floor(m.pos.y) === q.target.y);
      assert.ok(m.pos.x < p.layout.riverX0 + 1 || onFilledBridgeCell,
        `${m.name} is on unfilled water at t=${t.toFixed(1)}`);
    }
  }
  assert.equal(p.placedCount(), 3);
});

test("same seed replays identically (deterministic)", () => {
  const a = new BridgePuzzle(CREW, 42);
  const b = new BridgePuzzle(CREW, 42);
  for (let i = 0; i < 400; i++) { a.tick(0.05); b.tick(0.05); }
  const sa = a.snapshot(), sb = b.snapshot();
  assert.deepEqual(sa.members.map((m) => [m.x, m.y, m.state]), sb.members.map((m) => [m.x, m.y, m.state]));
  assert.deepEqual(sa.pieces.map((p) => [p.x, p.y, p.state]), sb.pieces.map((p) => [p.x, p.y, p.state]));
  assert.deepEqual(
    { river: [sa.riverX0, sa.bridgeY], homes: sa.pieces.map((p) => [p.x, p.y]) },
    { river: [sb.riverX0, sb.bridgeY], homes: sb.pieces.map((p) => [p.x, p.y]) },
  );
});

test("water blocks movement until a piece fills the gap cell", () => {
  const p = new BridgePuzzle(CREW, 7);
  const l = p.layout;
  assert.ok(!p.walkable(l.riverX0 + 0.5, l.bridgeY + 0.5), "unfilled gap cell is not walkable");
  assert.ok(p.walkable(l.flag.x + 0.5, l.flag.y + 0.5), "flag tile is walkable");
  assert.ok(p.walkable(l.riverX0 - 1 + 0.5, l.bridgeY + 0.5), "near bank is walkable");
});

test("complete means everyone crossed: crossing phase comes first", () => {
  const p = new BridgePuzzle(CREW, 7);
  let sawCrossingPhase = false;
  let t = 0;
  while (t < 300 && p.status !== "complete") {
    p.tick(0.1);
    t += 0.1;
    const s = p.snapshot();
    if (s.status === "crossing") {
      sawCrossingPhase = true;
      // During the crossing phase the win is not declared yet: at least one
      // crew member is still short of the flag.
      assert.ok(s.crossedCount < s.members.length, "crossing phase must end before all are across");
      assert.ok(s.members.some((m) => m.state === "crossing"), "someone still en route");
    }
  }
  assert.ok(sawCrossingPhase, "a crossing phase should exist between bridge-built and complete");
  const s = p.snapshot();
  assert.equal(s.status, "complete");
  assert.equal(s.crossedCount, s.members.length, "complete only once every member crossed");
  assert.ok(s.members.every((m) => m.state === "celebrating"), "everyone celebrating at the flag");
});
test("a controller reporting failed() freezes the engine completely", () => {
  const crew = [
    { id: "a", name: "Pip", color: "#ff7a59" },
    { id: "b", name: "Marlo", color: "#4a90d9" },
    { id: "c", name: "Juniper", color: "#b36bd6" },
    { id: "d", name: "Gus", color: "#3fb57a" },
  ];
  const p = new BridgePuzzle(crew, 7);
  p.setController({ decide: () => "pending", failed: () => true });
  const before = JSON.stringify(p.snapshot());
  for (let i = 0; i < 600; i++) p.tick(0.05); // 30 sim-seconds
  assert.equal(JSON.stringify(p.snapshot()), before, "no tick advances anything while failed");
  assert.equal(p.status, "building");
});
