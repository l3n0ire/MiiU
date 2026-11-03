import { test } from "node:test";
import assert from "node:assert/strict";
import { MazeMinds } from "./maze-minds.ts";
import { Maze, generateMazeLayout, type CrewMember } from "./maze-engine.ts";
import type { JsonCaller } from "../server/llm-json.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

type Move = { action: "fetch" | "hold" | "release" | "scout" | "share" | "wait"; crate: string; plate: string; reason: string };
type Script = (me: string, prompt: string) => Move;

function mindCaller(script: Script, opts: { failFor?: string; hangFor?: string } = {}) {
  const caller = {
    provider: "ollama" as const,
    model: "fake-minds",
    calls: 0,
    prompts: [] as { me: string; prompt: string }[],
    async callJson<T>(prompt: string, _schema: object): Promise<T> {
      caller.calls++;
      const me = /You are (\w+)\./.exec(prompt)?.[1] ?? "?";
      caller.prompts.push({ me, prompt });
      if (opts.failFor && me === opts.failFor) throw new Error("connection refused");
      if (opts.hangFor && me === opts.hangFor) return new Promise<T>(() => {});
      return script(me, prompt) as T;
    },
  };
  return caller;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function runWithMinds(p: Maze, clock: { t: number }, maxSeconds: number): Promise<number> {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status === "running") {
    for (let i = 0; i < 20 && p.status === "running"; i++) { p.tick(dt); t += dt; }
    clock.t += 2000; // let per-mind cooldowns pass between flushes
    await flush();
  }
  return t;
}

// A sensible scripted crew: Pip scouts and shares; Marlo and Juniper hold the
// two plates; anyone free fetches the first unclaimed crate; the golden cache
// is fetched once known. The script only parses the same prompt a real model
// would get - no coaching on values.
const cooperative: Script = (me, prompt) => {
  if (prompt.includes('"share" to tell the crew about the crack you found')) {
    return { action: "share", crate: "", plate: "", reason: `${me} tells the crew about the crack` };
  }
  if (/HOLDING plate-\d/.test(prompt)) {
    return { action: "wait", crate: "", plate: "", reason: `${me} keeps holding` };
  }
  if (prompt.includes("- cache-0 (golden)") && prompt.includes("- cache-0 (golden) at") && /cache-0 \(golden\) at \(\d+,\d+\) - unclaimed/.test(prompt)) {
    return { action: "fetch", crate: "cache-0", plate: "", reason: `${me} grabs the golden crate` };
  }
  if (me === "Pip" && prompt.includes('"scout" to walk the camp-side walls')) {
    return { action: "scout", crate: "", plate: "", reason: `${me} goes looking for a hidden way` };
  }
  if (me === "Marlo" || me === "Juniper") {
    const free = [...prompt.matchAll(/^- (plate-\d+) at \(\d+,\d+\): free$/gm)].map((m) => m[1]);
    if (free.length) return { action: "hold", crate: "", plate: free[0], reason: `${me} holds ${free[0]}` };
  }
  const open = [...prompt.matchAll(/^- (crate-\d+) at .* - unclaimed/gm)].map((m) => m[1]);
  if (open.length) return { action: "fetch", crate: open[0], plate: "", reason: `${me} grabs ${open[0]}` };
  return { action: "wait", crate: "", plate: "", reason: `${me} waits` };
};

function crackedSeed(): number {
  for (let s = 1; s < 200; s++) if (generateMazeLayout(s).crack) return s;
  throw new Error("none");
}

test("each mii decides for itself: plates held, crates fetched, crack scouted, shared and looted", async () => {
  const clock = { t: 0 };
  const p = new Maze(CREW, crackedSeed());
  const caller = mindCaller(cooperative);
  const minds = new MazeMinds(caller, { now: () => clock.t, maxCalls: 120 });
  p.setController(minds);
  await runWithMinds(p, clock, 1500);
  assert.equal(p.status, "complete");
  assert.equal(p.deliveredCount(), 4);
  const s = p.snapshot();
  assert.equal(s.stats.discoveries.length, 1, "exactly one discovery");
  assert.equal(s.stats.discoveries[0].name, "Pip");
  assert.equal(s.stats.shares.length, 1);
  assert.equal(s.stats.shares[0].name, "Pip");
  assert.ok(s.stats.cacheDeliveredBy, "the golden cache was looted after the share");
  for (const m of p.members) {
    assert.ok(p.decisionViewFor(m.id).crackIKnow, `${m.name} knows the crack after the share`);
  }
  assert.ok(minds.stats().calls > 6, "several independent decisions happened");
});

test("prompt privacy: no crack location or cache before discovery, not even via route lengths", async () => {
  const seed = crackedSeed();
  const l = generateMazeLayout(seed);
  const clock = { t: 10_000 };
  const p = new Maze(CREW, seed);
  const caller = mindCaller(cooperative);
  const minds = new MazeMinds(caller, { now: () => clock.t });
  p.setController(minds);
  p.tick(0.5); // one dispatch round, nobody has discovered anything
  await flush();
  assert.equal(caller.prompts.length, 4, "every free mii got exactly one prompt");
  const crackCoord = `(${l.crack!.ax},${l.crack!.ay})`;
  const chamberCoord = `(${l.chamber!.x},${l.chamber!.y})`;
  for (const q of caller.prompts) {
    assert.ok(!q.prompt.includes("crack in the maze wall at"), `${q.me} saw a crack location`);
    assert.ok(!q.prompt.includes(crackCoord), `${q.me} saw the crack coordinates`);
    assert.ok(!q.prompt.includes("cache-0"), `${q.me} saw the hidden cache crate`);
    assert.ok(!q.prompt.includes("golden"), `${q.me} saw the golden crate`);
    assert.ok(!q.prompt.includes(chamberCoord), `${q.me} saw the cache room coordinates`);
  }
});

test("sharing OFF: prompt forbids sharing, never offers it, and the engine enforces it", async () => {
  const clock = { t: 10_000 };
  const p = new Maze(CREW, crackedSeed());
  p.setSharing(false);
  const caller = mindCaller(cooperative);
  const minds = new MazeMinds(caller, { now: () => clock.t });
  p.setController(minds);
  p.tick(0.5);
  await flush();
  for (const q of caller.prompts) {
    assert.ok(q.prompt.includes('Sharing is OFF for this run. Do not choose "share"'), `${q.me} was told sharing is off`);
    assert.ok(!q.prompt.includes('"share" to tell the crew'), `${q.me} was offered share with sharing off`);
  }
  // even a direct share choice is rejected by the engine
  const a = p.members[0];
  let found = false;
  for (let trip = 0; trip < 10 && !found; trip++) {
    p.applyDecision(a.id, { action: "scout", reason: "" });
    let t = 0;
    while (t < 90 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
    found = p.decisionViewFor(a.id).iFoundUnshared !== null;
  }
  assert.ok(found, "crack found privately");
  // the discoverer's prompt says it cannot share - and does not invite sharing
  const caller2 = mindCaller(cooperative);
  const minds2 = new MazeMinds(caller2, { now: () => clock.t });
  p.setController(minds2);
  p.tick(0.5);
  await flush();
  const pipPrompts = caller2.prompts.filter((q) => q.me === "Pip");
  assert.ok(pipPrompts.length > 0, "the discoverer got a fresh prompt");
  const prompt = pipPrompts[pipPrompts.length - 1].prompt;
  assert.ok(prompt.includes("You cannot share the crack"), "discoverer told sharing is impossible");
  assert.ok(!prompt.includes("It is your choice"), "no share invitation in the OFF prompt");
  const denied = p.applyDecision(a.id, { action: "share", reason: "" });
  assert.equal(denied.ok, false);
});

test("budget exhaustion fails the run; an adjustable-budget restart completes", async () => {
  const clock = { t: 0 };
  const p = new Maze(CREW, crackedSeed());
  const caller = mindCaller(cooperative);
  const minds = new MazeMinds(caller, { now: () => clock.t, maxCalls: 5 });
  p.setController(minds);
  await runWithMinds(p, clock, 300);
  assert.equal(p.status, "failed", "run failed at the budget wall");
  assert.ok(p.snapshot().log.some((l) => l.text.includes("failed to accomplish the task")));
  assert.equal(p.deliveredCount() < 4, true, "no silent built-in completion");
  // restart the same layout with a bigger budget
  const p2 = new Maze(CREW, p.seed);
  minds.newPuzzle(120);
  p2.setController(minds);
  await runWithMinds(p2, clock, 1500);
  assert.equal(p2.status, "complete");
});

test("per-mii fallback: one unreachable model falls back, the rest keep deciding, run completes", async () => {
  const clock = { t: 0 };
  const p = new Maze(CREW, 7);
  const caller = mindCaller(cooperative, { failFor: "Juniper" });
  const minds = new MazeMinds(caller, { now: () => clock.t, maxCalls: 120 });
  p.setController(minds);
  await runWithMinds(p, clock, 1500);
  assert.equal(p.status, "complete");
  const statuses = minds.statuses();
  const juniper = statuses.find((s) => s.name === "Juniper")!;
  assert.equal(juniper.state, "fallback");
  assert.ok(juniper.detail.includes("built-in"));
  assert.ok(statuses.filter((s) => s.state === "fallback").length === 1, "only Juniper fell back");
});

test("sharing OFF: cache activity never reaches an ignorant mii's actual prompt", async () => {
  const clock = { t: 10_000 };
  const p = new Maze(CREW, crackedSeed());
  p.setSharing(false);
  const caller = mindCaller(() => ({ action: "wait", crate: "", plate: "", reason: "waiting" }));
  const minds = new MazeMinds(caller, { now: () => clock.t });
  p.setController(minds);
  p.tick(0.5);
  await flush();
  assert.equal(caller.prompts.length, 4, "everyone got an opening prompt");
  const a = p.members[0];
  // private discovery + private cache fetch, driven through the engine directly
  let found = false;
  for (let trip = 0; trip < 10 && !found; trip++) {
    p.applyDecision(a.id, { action: "scout", reason: "" });
    let t = 0;
    while (t < 90 && a.state === "scouting") { p.tick(0.05); t += 0.05; }
    found = p.decisionViewFor(a.id).iFoundUnshared !== null;
  }
  assert.ok(found, "crack found privately");
  assert.ok(p.applyDecision(a.id, { action: "fetch", crate: "cache-0", reason: "" }).ok, "private cache fetch starts");
  // public activity too, so ignorant miis DO get re-prompted with a fresh board
  assert.ok(p.applyDecision(p.members[1].id, { action: "hold", plate: "plate-0", reason: "" }).ok);
  caller.prompts.length = 0; // watch only prompts issued after the cache fetch began
  for (let i = 0; i < 8; i++) { clock.t += 60_000; p.tick(0.5); await flush(); }
  const ignorant = caller.prompts.filter((q) => q.me === "Juniper" || q.me === "Gus");
  assert.ok(ignorant.length > 0, "ignorant miis were re-prompted after the private fetch began");
  for (const q of ignorant) {
    assert.ok(!/cache/i.test(q.prompt), `${q.me} saw cache activity on the shared board`);
    assert.ok(!/golden/i.test(q.prompt), `${q.me} saw the golden crate`);
    assert.ok(q.prompt.includes("Marlo"), "public board activity still reaches ignorant miis");
  }
});
