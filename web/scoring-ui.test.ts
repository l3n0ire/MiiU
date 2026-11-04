import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDriver, recordCompletion, type MindsLike } from "./scoring-ui.ts";
import { loadHistory, HISTORY_KEY, type ScoreStorage } from "./scoring.ts";

function memStorage(): ScoreStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function fakeMinds(calls: number, states: string[], modelLabel = "qwen (Ollama)"): MindsLike {
  return {
    stats: () => ({ calls }),
    statuses: () => states.map((state) => ({ state })),
    modelLabel,
  };
}

const base = { mode: "maze" as const, seed: 7, sharing: true, elapsed: 100, speed: 1 };

test("deriveDriver: no minds connected is builtin", () => {
  assert.equal(deriveDriver(null), "builtin");
});

test("deriveDriver: connected but zero model calls is builtin", () => {
  assert.equal(deriveDriver(fakeMinds(0, ["active", "active"])), "builtin");
});

test("deriveDriver: model calls with no fallback is model", () => {
  assert.equal(deriveDriver(fakeMinds(12, ["active", "thinking"])), "model");
});

test("deriveDriver: any character on fallback makes the run mixed", () => {
  assert.equal(deriveDriver(fakeMinds(12, ["active", "fallback"])), "mixed");
});

test("recordCompletion: first run on a layout reports a finish, not a best", () => {
  const s = memStorage();
  const { line } = recordCompletion(s, { ...base, minds: null });
  assert.equal(line, "Finished in 100s of island time");
  assert.equal(loadHistory(s).length, 1);
});

test("recordCompletion: strictly faster rerun on the same layout is a new best", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, elapsed: 80, minds: null });
  assert.equal(line, "New best on this layout: 80s");
});

test("recordCompletion: tying the best is not announced as a new best", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, minds: null });
  assert.equal(line, "100s - #1 of 2 runs on this layout");
});

test("recordCompletion: slower rerun ranks behind, counts include the new run", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, elapsed: 120, minds: null });
  assert.equal(line, "120s - #2 of 2 runs on this layout");
});

test("recordCompletion: a different layout seed is not comparable", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, seed: 99, minds: null });
  assert.equal(line, "Finished in 100s of island time");
});

test("recordCompletion: stores driver, model, calls and speed as metadata", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: fakeMinds(9, ["active"]), speed: 4 });
  const [saved] = loadHistory(s);
  assert.equal(saved.driver, "model");
  assert.equal(saved.model, "qwen (Ollama)");
  assert.equal(saved.calls, 9);
  assert.equal(saved.speed, 4);
  assert.equal(saved.mode, "maze");
  assert.equal(saved.seed, 7);
});

test("recordCompletion: persists under the scoring module's history key", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  assert.ok(s.data.has(HISTORY_KEY));
});
