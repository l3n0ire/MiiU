import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDriver, recordCompletion, renderHistory, type MindsLike } from "./scoring-ui.ts";
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

test("recordCompletion: first run yields no score line (win stats already show the time)", () => {
  const s = memStorage();
  const { line } = recordCompletion(s, { ...base, minds: null });
  assert.equal(line, null);
  assert.equal(loadHistory(s).length, 1);
});

test("recordCompletion: strictly faster rerun on the same layout is a new best", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, elapsed: 80, minds: null });
  assert.equal(line, "New best on this layout: 80.0s");
});

test("recordCompletion: tying the best is not announced as a new best", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, minds: null });
  assert.equal(line, "100.0s - #1 of 2 runs on this layout");
});

test("recordCompletion: slower rerun ranks behind, counts include the new run", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, elapsed: 120, minds: null });
  assert.equal(line, "120.0s - #2 of 2 runs on this layout");
});

test("recordCompletion: a different layout seed is not comparable (no best/rank line)", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: null });
  const { line } = recordCompletion(s, { ...base, seed: 99, minds: null });
  assert.equal(line, null);
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

test("renderHistory: rows show rank, score, layout, driver, playback speed and date", () => {
  const s = memStorage();
  recordCompletion(s, { ...base, minds: fakeMinds(9, ["active"]), speed: 4, elapsed: 120 });
  recordCompletion(s, { ...base, minds: null, speed: 1, elapsed: 100 });
  const rows: string[] = [];
  const fakeDoc = { createElement: () => ({ textContent: "" }) };
  const fakeEl = {
    ownerDocument: fakeDoc,
    set textContent(_v: string) {},
    appendChild(row: { textContent: string }) { rows.push(row.textContent); },
  };
  renderHistory(s, "maze", fakeEl as unknown as HTMLElement);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^#1 100.0s - layout #7 - builtin - 1x - /);
  assert.match(rows[1], /^#2 120.0s - layout #7 - model qwen \(Ollama\) - 4x - /);
});

test("renderHistory: empty history shows the empty state", () => {
  const s = memStorage();
  let text: string | null = null;
  const fakeEl = {
    ownerDocument: { createElement: () => ({ textContent: "" }) },
    set textContent(v: string) { text = v; },
    appendChild() {},
  };
  renderHistory(s, "maze", fakeEl as unknown as HTMLElement);
  assert.equal(text, "No completed runs yet.");
});
