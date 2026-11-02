import { test } from "node:test";
import assert from "node:assert/strict";
import { PuzzleBrain } from "./puzzle-brain.ts";
import { BridgePuzzle, type CrewMember, type DecisionView } from "./puzzle-engine.ts";
import type { JsonCaller } from "../server/llm-json.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

// A fake provider: no network, answers from the live decision view like a
// competent model would (placeable pieces only, free members, two on a beam).
function fakeCaller(opts: {
  fail?: boolean;
  nonsense?: boolean;
  onCall?: () => void;
} = {}): JsonCaller & { calls: number; lastOpts?: { maxOutputTokens?: number }; lastPrompt: string } {
  const caller = {
    provider: "ollama" as const,
    model: "fake-test-model",
    calls: 0,
    lastOpts: undefined as undefined | { maxOutputTokens?: number },
    lastPrompt: "",
    async callJson<T>(_prompt: string, _schema: object, callOpts?: { maxOutputTokens?: number }): Promise<T> {
      caller.calls++;
      caller.lastOpts = callOpts;
      caller.lastPrompt = _prompt;
      opts.onCall?.();
      if (opts.fail) throw new Error("connection refused");
      if (opts.nonsense) {
        return { assignments: [
          { piece: "piece-99", lead: "a", helper: "", reason: "no such piece" },
          { piece: "block-0", lead: "nobody", helper: "", reason: "no such member" },
        ] } as T;
      }
      const view = (caller as unknown as { currentView: DecisionView }).currentView;
      const free = view.members.filter((m) => m.free).map((m) => m.id);
      const assignments = [];
      for (const p of view.pieces) {
        if (!p.placeable) continue;
        if (p.heavy) {
          if (free.length >= 2) {
            const [lead, helper] = free.splice(0, 2);
            assignments.push({ piece: p.id, lead, helper, reason: `${lead} and ${helper} team up on the heavy one` });
          }
        } else if (free.length >= 1) {
          const [lead] = free.splice(0, 1);
          assignments.push({ piece: p.id, lead, helper: "", reason: `${lead} is closest` });
        }
      }
      return { assignments } as T;
    },
  };
  return caller;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Tick the puzzle in small chunks so the brain's async refresh can resolve
// between chunks, the way rAF frames interleave with microtasks in a browser.
async function runWithBrain(p: BridgePuzzle, brain: PuzzleBrain, maxSeconds: number): Promise<number> {
  let t = 0;
  const dt = 0.05;
  const status = () => p.status; // accessor keeps TS from narrowing across awaits
  while (t < maxSeconds && status() !== "complete") {
    for (let i = 0; i < 20 && status() !== "complete"; i++) { p.tick(dt); t += dt; }
    await flush();
  }
  return t;
}

// Give the fake caller the same view the brain sees: wrap decide to capture it.
function wireView(caller: JsonCaller, brain: PuzzleBrain, p: BridgePuzzle) {
  const inner = brain.decide.bind(brain);
  brain.decide = (view: DecisionView) => {
    (caller as unknown as { currentView: DecisionView }).currentView = view;
    return inner(view);
  };
  p.setController(brain);
}

test("a connected model chooses the crew's jobs and the puzzle completes", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const caller = fakeCaller();
  const brain = new PuzzleBrain(caller);
  wireView(caller, brain, p);
  const t = await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete", `gave up at t=${t.toFixed(1)}s`);
  const s = p.snapshot();
  assert.equal(s.placedCount, 3);
  assert.ok(s.assists >= 1, "beam lifts still need two miis");
  const st = brain.status();
  assert.equal(st.state, "active");
  assert.ok(st.decisionsApplied >= 3, `all 3 pieces claimed on model decisions, got ${st.decisionsApplied}`);
  assert.ok(caller.calls >= 2, "re-planned as the decision surface changed");
  assert.ok(st.lastReason, "kept the model's reason for the panel");
});

test("while the model is thinking the crew waits - no built-in claims", async () => {
  const p = new BridgePuzzle(CREW, 7);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const caller: JsonCaller = {
    provider: "ollama", model: "slow-model",
    callJson: async <T,>() => { await gate; return { assignments: [] } as T; },
  };
  const brain = new PuzzleBrain(caller);
  p.setController(brain);
  for (let i = 0; i < 100; i++) p.tick(0.05); // 5s with an unanswered call
  assert.ok(p.pieces.every((q) => q.state === "idle"), "nothing claimed while thinking");
  assert.ok(p.members.every((m) => ["idle", "wandering"].includes(m.state)), "crew only wanders");
  assert.equal(brain.status().state, "thinking");
  release();
});

test("model unreachable: honest fallback to built-in logic, puzzle still completes", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const caller = fakeCaller({ fail: true });
  const brain = new PuzzleBrain(caller);
  wireView(caller, brain, p);
  const t = await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete", `built-in logic finished, gave up at t=${t.toFixed(1)}s`);
  const st = brain.status();
  assert.equal(st.state, "fallback");
  assert.ok(st.detail.includes("Built-in logic"), `status says who is driving: ${st.detail}`);
  assert.ok(st.detail.includes("connection refused"), `status says why: ${st.detail}`);
  assert.equal(st.decisionsApplied, 0, "no model moves were made - the panel must not claim any");
});

test("an unusable model plan is rejected, not applied", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const caller = fakeCaller({ nonsense: true });
  const brain = new PuzzleBrain(caller);
  wireView(caller, brain, p);
  await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete");
  const st = brain.status();
  assert.equal(st.state, "fallback");
  assert.ok(st.detail.includes("no usable move"), st.detail);
  assert.equal(st.decisionsApplied, 0);
});

test("engine rejects illegal controller moves directly", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const view0 = p.decisionView();
  const placeable = view0.pieces.find((q) => q.placeable)!;
  p.setController({
    decide: () => [
      { piece: "ghost-1", lead: "a" }, // no such piece
      { piece: placeable.id, lead: "zzz" }, // no such member
      { piece: placeable.id, lead: "a", helper: "a" }, // lead cannot be own helper
    ],
  });
  for (let i = 0; i < 20; i++) p.tick(0.05);
  // All rejected -> zero applied -> built-in assigner covered the tick instead.
  assert.ok(p.pieces.some((q) => q.state !== "idle"), "built-in fallback claims when a plan is all-illegal");
});

test("no duplicate calls while one is in flight; new surface means a new call", async () => {
  const p = new BridgePuzzle(CREW, 7);
  let calls = 0;
  const caller = fakeCaller({ onCall: () => calls++ });
  const brain = new PuzzleBrain(caller);
  wireView(caller, brain, p);
  p.tick(0.05);
  p.tick(0.05); // same surface, call in flight
  await flush();
  assert.equal(calls, 1, "one in-flight call at a time");
  await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete");
  assert.ok(calls >= 2, "a changed decision surface triggers a fresh plan");
});

test("per-puzzle call budget caps spending on the visitor's key", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const caller = fakeCaller();
  const brain = new PuzzleBrain(caller);
  const base = p.decisionView();
  // Churn which pieces are placeable so every answer lands, gets consumed,
  // and the surface keeps changing - the worst case for re-planning.
  for (let i = 0; i < 40; i++) {
    const view: DecisionView = {
      ...base,
      pieces: base.pieces.map((q, j) => ({ ...q, placeable: (i + j) % 2 === 0 })),
    };
    if (!view.pieces.some((q) => q.placeable)) view.pieces[0].placeable = true;
    (caller as unknown as { currentView: DecisionView }).currentView = view;
    brain.decide(view);
    await flush();
    await flush();
  }
  assert.equal(caller.calls, 25, `calls bounded at 25, got ${caller.calls}`);
  const st = brain.status();
  assert.equal(st.state, "fallback");
  assert.ok(st.detail.includes("call budget"), st.detail);
});

test("every model request carries hard token bounds", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const caller = fakeCaller();
  const brain = new PuzzleBrain(caller);
  wireView(caller, brain, p);
  await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete");
  assert.equal(caller.lastOpts?.maxOutputTokens, 2000, "output capped server-side");
  assert.ok(caller.lastPrompt.length <= 8000, `prompt capped, got ${caller.lastPrompt.length} chars`);
});

test("a model answering with crew names instead of ids is understood", async () => {
  const p = new BridgePuzzle(CREW, 7);
  const nameCaller: JsonCaller & { calls: number } = {
    provider: "openai", model: "name-answering-model", calls: 0,
    async callJson<T>(): Promise<T> {
      nameCaller.calls++;
      const view = (nameCaller as unknown as { currentView: DecisionView }).currentView;
      const free = view.members.filter((m) => m.free);
      const assignments = [];
      for (const q of view.pieces) {
        if (!q.placeable) continue;
        if (q.heavy && free.length >= 2) {
          assignments.push({ piece: q.id, lead: free[0].name, helper: free[1].name, reason: "by name" });
        } else if (!q.heavy && free.length >= 1) {
          assignments.push({ piece: q.id, lead: free[0].name, helper: "", reason: "by name" });
        }
      }
      return { assignments } as T;
    },
  };
  const brain = new PuzzleBrain(nameCaller);
  wireView(nameCaller, brain, p);
  const t = await runWithBrain(p, brain, 400);
  assert.equal(p.status, "complete", `gave up at t=${t.toFixed(1)}s`);
  assert.ok(brain.status().decisionsApplied >= 3, "name-based answers accepted");
});
