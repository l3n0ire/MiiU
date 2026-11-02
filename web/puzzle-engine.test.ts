import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgePuzzle, FLAG, RIVER_X0, RIVER_X1, BRIDGE_Y, type CrewMember } from "./puzzle-engine.ts";

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

test("a full crew cooperates, builds the bridge and crosses to the flag", () => {
  const p = new BridgePuzzle(CREW, 7);
  const t = run(p, 240);
  assert.equal(p.status, "complete", `should finish, gave up at t=${t.toFixed(1)}s`);
  const s = p.snapshot();
  assert.equal(s.placedCount, 3);
  assert.equal(s.assists, 1, "the beam takes exactly one two-mii lift");
  assert.ok(s.bridge.every((c) => c.filled));
  // Someone actually stood on the flag side.
  assert.ok(s.members.some((m) => m.x > RIVER_X1), "at least one mii crossed the river");
});

test("pieces are placed in bridge order, extending from the near bank", () => {
  const p = new BridgePuzzle(CREW, 7);
  const order: number[] = [];
  const seen = new Set<string>();
  let t = 0;
  while (t < 240 && p.status !== "complete") {
    p.tick(0.05);
    t += 0.05;
    for (const piece of p.pieces) {
      if (piece.state === "placed" && !seen.has(piece.id)) {
        seen.add(piece.id);
        order.push(piece.target.x);
      }
    }
  }
  assert.deepEqual(order, [RIVER_X0, RIVER_X0 + 1, RIVER_X1], "near cell, then middle, then far cell");
});

test("the heavy beam never moves with fewer than two carriers", () => {
  const p = new BridgePuzzle([CREW[0]], 7); // a lone mii
  run(p, 120);
  const beam = p.pieces.find((q) => q.id === "beam")!;
  assert.notEqual(beam.state, "carried");
  assert.notEqual(beam.state, "placed");
  assert.equal(p.status, "building", "a lone mii cannot finish the bridge");
});

test("nobody crosses the river before the bridge is complete", () => {
  const p = new BridgePuzzle(CREW, 7);
  let t = 0;
  while (t < 240 && p.placedCount() < 3) {
    p.tick(0.05);
    t += 0.05;
    for (const m of p.members) {
      assert.ok(m.pos.x < RIVER_X0 + 1 || p.pieces.some((q) => q.state === "placed" && Math.floor(m.pos.x) === q.target.x && Math.floor(m.pos.y) === BRIDGE_Y),
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
});

test("flag is on the far bank and the gap spans the river", () => {
  assert.ok(FLAG.x > RIVER_X1);
  const p = new BridgePuzzle(CREW, 7);
  assert.ok(!p.walkable(RIVER_X0 + 0.5, BRIDGE_Y + 0.5), "unfilled gap cell is not walkable");
  assert.ok(p.walkable(FLAG.x + 0.5, FLAG.y + 0.5), "flag tile is walkable");
});
