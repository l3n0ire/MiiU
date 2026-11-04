import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreOf, comparable, compareRuns, bestRun, rankOf, recordRun, loadHistory,
  bannerLine, formatScore, HISTORY_KEY, MAX_HISTORY_PER_MODE,
  type RunRecord, type ScoreStorage,
} from "./scoring.ts";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    mode: "maze", seed: 7, driver: "builtin", model: null,
    sharing: true, elapsed: 155, calls: null, speed: 1,
    at: "2026-11-04T22:00:00Z",
    ...over,
  };
}

function memStorage(): ScoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

test("score is completion time, lower is better", () => {
  const fast = run({ elapsed: 100 });
  const slow = run({ elapsed: 200 });
  assert.equal(scoreOf(fast), 100);
  assert.ok(compareRuns(fast, slow) < 0);
  assert.ok(compareRuns(slow, fast) > 0);
});

test("equal completion times are equal scores - no tiebreakers", () => {
  // Model calls, driver, speed and date never break a tie.
  const a = run({ driver: "model", model: "m", calls: 5, speed: 4, at: "2026-11-04T23:00:00Z" });
  const b = run({ driver: "builtin", calls: null, speed: 1, at: "2026-11-04T21:00:00Z" });
  assert.equal(compareRuns(a, b), 0);
  const runs = [a, b, run({ elapsed: 200 })];
  assert.equal(rankOf(a, runs), 1, "tied runs share rank 1");
  assert.equal(rankOf(b, runs), 1, "tied runs share rank 1");
});

test("comparability is same mode and same layout seed", () => {
  const base = run();
  assert.ok(comparable(base, run({ elapsed: 999 })));
  assert.ok(!comparable(base, run({ seed: 8 })));
  assert.ok(!comparable(base, run({ mode: "expedition" })));
  // unknown-seed runs (null = engine did not report one) compare within the mode only
  assert.ok(comparable(run({ mode: "puzzle", seed: null }), run({ mode: "puzzle", seed: null })));
  // every current mode generates seeded layouts: different seeds never compare,
  // even in puzzle/crossing (they re-randomize on "New puzzle")
  assert.ok(!comparable(run({ mode: "puzzle", seed: 1 }), run({ mode: "puzzle", seed: 2 })));
  assert.ok(comparable(run({ mode: "puzzle", seed: 1 }), run({ mode: "puzzle", seed: 1 })));
});

test("bestRun picks the fastest comparable run only", () => {
  const base = run({ elapsed: 155 });
  const runs = [
    run({ elapsed: 200 }),
    run({ elapsed: 120 }), // best on seed 7
    run({ seed: 8, elapsed: 50 }), // different layout: ignored
    run({ mode: "expedition", elapsed: 40 }), // different mode: ignored
  ];
  const best = bestRun(runs, base);
  assert.equal(best?.elapsed, 120);
  assert.equal(best?.score, 120);
});

test("rankOf counts only comparable faster runs; new best ranks 1", () => {
  const runs = [run({ elapsed: 200 }), run({ elapsed: 120 }), run({ seed: 8, elapsed: 1 })];
  assert.equal(rankOf(run({ elapsed: 155 }), runs), 2);
  assert.equal(rankOf(run({ elapsed: 100 }), runs), 1);
});

test("recordRun persists and reloads; caps history per mode", () => {
  const s = memStorage();
  recordRun(s, run({ elapsed: 155 }));
  recordRun(s, run({ mode: "puzzle", seed: null, elapsed: 60 }));
  const loaded = loadHistory(s);
  assert.equal(loaded.length, 2);
  for (let i = 0; i < MAX_HISTORY_PER_MODE + 10; i++) recordRun(s, run({ elapsed: i }));
  const modes = loadHistory(s).filter((r) => r.mode === "maze");
  assert.equal(modes.length, MAX_HISTORY_PER_MODE);
});

test("loadHistory tolerates missing and corrupt data", () => {
  const s = memStorage();
  assert.deepEqual(loadHistory(s), []);
  s.data.set(HISTORY_KEY, "not json");
  assert.deepEqual(loadHistory(s), []);
  s.data.set(HISTORY_KEY, JSON.stringify({ version: 2, runs: [] }));
  assert.deepEqual(loadHistory(s), []);
});

test("bannerLine announces new best, ranked finish, and first finish", () => {
  const first = run({ elapsed: 155 });
  assert.match(bannerLine(first, [first]), /Finished in 155s/);
  const runs = [run({ elapsed: 200 }), run({ elapsed: 120 })];
  assert.match(bannerLine(run({ elapsed: 155 }), [...runs, run({ elapsed: 155 })]), /#2 of 3 runs on this layout/);
  // strictly faster than all others: a new best
  assert.match(bannerLine(run({ elapsed: 100 }), runs), /New best on this layout: 100s/);
  // tying the best is rank #1 but NOT a new best (equal times are equal scores)
  assert.match(bannerLine(run({ elapsed: 120 }), [...runs]), /#1 of 2 runs on this layout/);
  // null-seed scope uses the mode's display label, not the raw id
  const p60 = run({ mode: "puzzle", seed: null, elapsed: 60 });
  assert.match(bannerLine(p60, [p60, run({ mode: "puzzle", seed: null, elapsed: 90 })]), /New best in the Bridge Puzzle: 60s/);
});

test("formatScore rounds island seconds", () => {
  assert.equal(formatScore(run({ elapsed: 155.4 })), "155s");
});

test("playback speed does not change the score (integration, built-in maze run)", async () => {
  const { Maze } = await import("./maze-engine.ts");
  const crew = [
    { id: "a", name: "Pip", color: "#ff7a59" },
    { id: "b", name: "Marlo", color: "#4a90d9" },
    { id: "c", name: "Juniper", color: "#b36bd6" },
    { id: "d", name: "Gus", color: "#3fb57a" },
  ];
  const finish = (speed: number): number => {
    const p = new Maze(crew, 7);
    p.speed = speed;
    const dt = 0.05;
    let t = 0;
    while (p.status === "running" && t * speed < 1200) { p.tick(dt); t += dt; }
    assert.equal(p.status, "complete", `speed ${speed} completes`);
    return p.elapsed;
  };
  const at1x = finish(1);
  const at4x = finish(4);
  // Identical up to tick quantization (dt*speed per tick); the displayed
  // score (rounded island seconds) must be the same.
  assert.ok(Math.abs(at1x - at4x) <= 1, `1x (${at1x}) and 4x (${at4x}) within tick quantization`);
  assert.equal(Math.round(at1x), Math.round(at4x), "displayed score is speed-independent");
});
