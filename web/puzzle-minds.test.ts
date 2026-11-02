import { test } from "node:test";
import assert from "node:assert/strict";
import { MindfulCrew } from "./puzzle-minds.ts";
import { BridgePuzzle, type CrewMember, type DecisionView } from "./puzzle-engine.ts";
import type { JsonCaller } from "../server/llm-json.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

type Move = { action: "claim" | "help" | "decline" | "wait"; piece: string; reason: string };
type Script = (me: string, prompt: string, state: { callsBy: Map<string, number> }) => Move;

function mindCaller(script: Script, opts: { failFor?: string } = {}): JsonCaller & { calls: number; prompts: { me: string; prompt: string }[] } {
  const callsBy = new Map<string, number>();
  const caller = {
    provider: "ollama" as const,
    model: "fake-minds",
    calls: 0,
    prompts: [] as { me: string; prompt: string }[],
    async callJson<T>(prompt: string, _schema: object, callOpts?: { maxOutputTokens?: number }): Promise<T> {
      caller.calls++;
      const me = /You are (\w+)\./.exec(prompt)?.[1] ?? "?";
      caller.prompts.push({ me, prompt });
      if (opts.failFor && prompt.includes(`You are ${opts.failFor}.`)) throw new Error("connection refused");
      const n = (callsBy.get(me) ?? 0) + 1;
      callsBy.set(me, n);
      return script(me, prompt, { callsBy }) as T;
    },
  };
  return caller;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function runWithMinds(p: BridgePuzzle, crew: MindfulCrew, clock: { t: number }, maxSeconds: number): Promise<number> {
  let t = 0;
  const dt = 0.05;
  const status = () => p.status;
  while (t < maxSeconds && status() !== "complete") {
    for (let i = 0; i < 20 && status() !== "complete"; i++) { p.tick(dt); t += dt; }
    clock.t += 2000; // let per-mind cooldowns pass between flushes
    await flush();
  }
  return t;
}

function announcedBlocks(prompt: string): string[] {
  return [...prompt.matchAll(/^\w+ is fetching (block-\d+)/gm)].map((m) => m[1]);
}
function openAsks(prompt: string): string[] {
  return [...prompt.matchAll(/^\w+ wants to lift (beam-\d+)/gm)].map((m) => m[1]);
}
function placeable(prompt: string): { id: string; heavy: boolean }[] {
  const section = prompt.split("Pieces that CAN be placed right now")[1]?.split("\n\n")[0] ?? "";
  return [...section.matchAll(/^- ((?:block|beam)-\d+) \((block|beam)/gm)].map((m) => ({ id: m[1], heavy: m[2] === "beam" }));
}

// A sensible independent character: answer an open beam ask if it is the
// closest free mii behavior we scripted; otherwise claim the first placeable
// block nobody announced; claim a lone beam only when nothing else remains.
const cooperative: Script = (me, prompt) => {
  const asks = openAsks(prompt);
  if (asks.length) return { action: "help", piece: asks[0], reason: `${me} answers the call for ${asks[0]}` };
  const taken = new Set(announcedBlocks(prompt));
  const free = placeable(prompt).filter((p) => !p.heavy && !taken.has(p.id));
  if (free.length) return { action: "claim", piece: free[0].id, reason: `${me} grabs ${free[0].id} since it is open` };
  const beam = placeable(prompt).find((p) => p.heavy);
  if (beam) return { action: "claim", piece: beam.id, reason: `${me} asks for a partner on ${beam.id}` };
  return { action: "wait", piece: "", reason: `${me} waits` };
};

test("autonomous characters each decide for themselves and finish the bridge", async () => {
  const clock = { t: 0 };
  const p = new BridgePuzzle(CREW, 7);
  const caller = mindCaller(cooperative);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const t = await runWithMinds(p, crew, clock, 400);
  assert.equal(p.status, "complete", `puzzle should complete (t=${t})`);
  // every character made its own model calls - no central planner
  const speakers = new Set(caller.prompts.map((x) => x.me));
  assert.ok(speakers.size >= 3, `expected >=3 characters deciding independently, got ${[...speakers]}`);
  // per-character prompts carry that character's own perspective
  const pip = caller.prompts.find((x) => x.me === "Pip")!;
  assert.match(pip.prompt, /You are Pip\./);
  assert.match(pip.prompt, /Your position:/);
  assert.match(pip.prompt, /Announced intentions:/);
  // per-character driver status: all model-driven, none fallen back
  for (const s of crew.statuses()) {
    assert.equal(s.state, "active", `${s.name} should be model-driven: ${s.detail}`);
    assert.equal(s.modelLabel, "fake-minds (Ollama)");
  }
  assert.ok(caller.calls >= 4 && caller.calls <= 40, `call count in bounded range: ${caller.calls}`);
});

test("beams move only when two characters independently agree - no manufactured consent", async () => {
  const clock = { t: 0 };
  // nobody ever answers a beam ask: blocks get done, the beam never starts
  const selfish: Script = (me, prompt) => {
    const taken = new Set(announcedBlocks(prompt));
    const free = placeable(prompt).filter((p) => !p.heavy && !taken.has(p.id));
    if (free.length) return { action: "claim", piece: free[0].id, reason: "mine" };
    if (/already has a lead asking for help/.test(prompt)) return { action: "wait", piece: "", reason: "someone else is on the beam" };
    const beam = placeable(prompt).find((p) => p.heavy);
    if (beam) return { action: "claim", piece: beam.id, reason: `${me} wants help on ${beam.id}` };
    return { action: "wait", piece: "", reason: "waiting" };
  };
  const p = new BridgePuzzle(CREW, 11); // seed 11 opens with block-0 placeable
  const caller = mindCaller(selfish);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  await runWithMinds(p, crew, clock, 150);
  assert.notEqual(p.status, "complete");
  const view = p.decisionView();
  // blocks still got carried by their solo claimants
  assert.ok(view.pieces.filter((x) => !x.heavy && (x.placed || x.claimed)).length >= 1, "solo blocks progress");
  // every beam that is the subject of an unanswered ask stays unmoved -
  // the engine never invents a partner
  for (const beam of view.pieces.filter((x) => x.heavy)) {
    if (!beam.placed) assert.equal(beam.claimed, false, `${beam.id}: unmoved while nobody accepts the ask`);
  }
  assert.ok(caller.calls <= 40, `aggregate call cap holds under adversarial script: ${caller.calls}`);
});

test("a beam completes when one character asks and another independently accepts", async () => {
  const clock = { t: 0 };
  const p = new BridgePuzzle(CREW, 7);
  const caller = mindCaller(cooperative);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const t = await runWithMinds(p, crew, clock, 400);
  assert.equal(p.status, "complete", `t=${t}`);
  // the heavy beam really moved with two named, independently-deciding miis
  const finalView = p.decisionView();
  assert.ok(finalView.pieces.every((x) => x.placed), "all pieces placed");
  const helpPrompt = caller.prompts.find((x) => /ASKING for a partner/.test(x.prompt) && /"help"/.test(x.prompt) || /wants to lift/.test(x.prompt));
  assert.ok(helpPrompt, "some character saw the open ask on its board");
  const helpAnswers = caller.prompts.filter((x) => /wants to lift beam-\d+/.test(x.prompt));
  assert.ok(helpAnswers.length >= 1, "the ask reached at least one other character's prompt");
});

test("conflicting claims resolve with feedback to the loser, and calls stay bounded", async () => {
  const clock = { t: 0 };
  // everyone always claims block-0 while it is placeable: constant conflict
  const stubborn: Script = (me, prompt) => {
    const ps = placeable(prompt);
    const target = ps.find((x) => x.id === "block-0") ?? ps.find((x) => !x.heavy) ?? ps[0];
    if (target) return { action: "claim", piece: target.id, reason: `${me} insists on ${target.id}` };
    return { action: "wait", piece: "", reason: "nothing left" };
  };
  const p = new BridgePuzzle(CREW, 11);
  const caller = mindCaller(stubborn);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  await runWithMinds(p, crew, clock, 60);
  // exactly one character holds block-0; losers were told, in their memory,
  // and re-decided instead of stall-looping
  const view = p.decisionView();
  const b0 = view.pieces.find((x) => x.id === "block-0")!;
  assert.ok(b0.claimed || b0.placed, "block-0 got exactly one owner");
  const losersSawFeedback = caller.prompts.filter((x) => /rejected:|taken by/.test(x.prompt));
  assert.ok(losersSawFeedback.length >= 1, "losing minds see the rejection in later prompts");
  assert.ok(caller.calls <= 40, `aggregate call cap holds: ${caller.calls}`);
});

test("one character's model failure falls back alone; the others stay model-driven", async () => {
  const clock = { t: 0 };
  const p = new BridgePuzzle(CREW, 7);
  const caller = mindCaller(cooperative, { failFor: "Gus" });
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const t = await runWithMinds(p, crew, clock, 400);
  assert.equal(p.status, "complete", `t=${t}`);
  const statuses = crew.statuses();
  const gus = statuses.find((s) => s.name === "Gus")!;
  assert.equal(gus.state, "fallback");
  assert.match(gus.detail, /built-in \(connection refused\)/);
  const others = statuses.filter((s) => s.name !== "Gus");
  assert.ok(others.length >= 2 && others.every((s) => s.state === "active"), "others keep their model drivers");
});

test("token/request bounds travel on every per-character call", async () => {
  const clock = { t: 0 };
  const seen: { maxOutputTokens?: number }[] = [];
  const p = new BridgePuzzle(CREW, 7);
  const base = mindCaller(cooperative);
  const caller: typeof base = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    async callJson<T>(prompt: string, schema: object, callOpts?: { maxOutputTokens?: number }): Promise<T> {
      seen.push(callOpts ?? {});
      return base.callJson<T>(prompt, schema, callOpts);
    },
  });
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  await runWithMinds(p, crew, clock, 400);
  assert.ok(seen.length >= 4, "calls happened");
  for (const o of seen) assert.equal(o.maxOutputTokens, 2000, "server-enforced output cap on every call");
  for (const x of caller.prompts) assert.ok(x.prompt.length <= 8000, `prompt char cap holds (${x.prompt.length})`);
});

test("a reply arriving after the 30s timeout cannot commit on the fallen-back mind", async () => {
  const clock = { t: 10_000 };
  const releases: ((v: unknown) => void)[] = [];
  const caller: JsonCaller & { calls: number } = {
    provider: "ollama", model: "fake-slow", calls: 0,
    callJson<T>(): Promise<T> {
      caller.calls++;
      return new Promise<T>((resolve) => { releases.push(resolve as (v: unknown) => void); });
    },
  };
  const p = new BridgePuzzle(CREW, 7);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  p.tick(0.05); await flush(); // starts calls (they hang)
  clock.t += 31_000; // past THINKING_TIMEOUT_MS
  p.tick(0.05); await flush(); // timeout registers: mind marked failed
  const during = crew.statuses().find((s) => s.name === "Pip")!;
  assert.equal(during.state, "fallback");
  assert.match(during.detail, /no answer after 30s/);
  // the late reply now arrives - it must not touch anything
  releases.forEach((r) => r({ action: "claim", piece: "block-0", reason: "sneaky late answer" }));
  await flush(); await flush();
  p.tick(0.05); await flush();
  const after = crew.statuses().find((s) => s.name === "Pip")!;
  assert.equal(after.state, "fallback", "still fallen back - late reply did not revive the mind");
  assert.match(after.detail, /no answer after 30s/, "driver line unchanged");
  assert.notEqual(after.lastReason, "sneaky late answer", "no memory/reason mutation from the stale reply");
  // and no intention leaked onto the board: Pip is covered by built-in, so
  // the engine must not receive a model decision credited to a
  const view = p.decisionView();
  const pipBusyWithModelPiece = view.inProgress.some((w) => w.lead === "a" && w.piece === "block-0");
  assert.equal(pipBusyWithModelPiece, false, "late claim never reached the engine");
});

test("a reply from before a puzzle reset cannot commit on the fresh puzzle", async () => {
  const clock = { t: 10_000 };
  const releases: ((v: unknown) => void)[] = [];
  let calls = 0;
  const caller: JsonCaller = {
    provider: "ollama", model: "fake-slow",
    callJson<T>(): Promise<T> {
      calls++;
      if (calls === 1) return new Promise<T>((resolve) => { releases.push(resolve as (v: unknown) => void); });
      return Promise.resolve({ action: "wait", piece: "", reason: "fresh puzzle, watching" } as T);
    },
  };
  const p = new BridgePuzzle(CREW, 7);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  p.tick(0.05); await flush(); // call 1 in flight (hangs)
  crew.newPuzzle(); // reset while the reply is outstanding
  releases.forEach((r) => r({ action: "claim", piece: "block-0", reason: "stale pre-reset answer" }));
  await flush(); await flush();
  clock.t += 2000;
  p.tick(0.05); await flush();
  const pip = crew.statuses().find((s) => s.name === "Pip")!;
  assert.notEqual(pip.lastReason, "stale pre-reset answer", "stale reply discarded after reset");
  assert.notEqual(pip.state, "fallback");
  const view = p.decisionView();
  assert.equal(view.inProgress.some((w) => w.piece === "block-0" && w.lead === "a"), false);
});

test("an explicit decline is told to the asker; when everyone declines the asker chooses anew", async () => {
  const clock = { t: 10_000 };
  // Pip always asks on the first beam; everyone else openly declines it.
  const script: Script = (me, prompt) => {
    if (me === "Pip") {
      if (/everyone declined/.test(prompt)) return { action: "wait", piece: "", reason: "no one will join me, fine" };
      const beam = placeable(prompt).find((x) => x.heavy);
      if (beam && !/ASKING for a partner/.test(prompt)) return { action: "claim", piece: beam.id, reason: "Pip asks for a partner" };
      return { action: "wait", piece: "", reason: "Pip waits" };
    }
    const asks = openAsks(prompt);
    if (asks.length && !/you declined/.test(prompt)) return { action: "decline", piece: asks[0], reason: `${me} does not want the beam` };
    const taken = new Set(announcedBlocks(prompt));
    const free = placeable(prompt).filter((x) => !x.heavy && !taken.has(x.id));
    if (free.length) return { action: "claim", piece: free[0].id, reason: "mine" };
    return { action: "wait", piece: "", reason: "waiting" };
  };
  const p = new BridgePuzzle(CREW, 7);
  const caller = mindCaller(script);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  await runWithMinds(p, crew, clock, 90);
  const view = p.decisionView();
  for (const beam of view.pieces.filter((x) => x.heavy)) {
    if (!beam.placed) assert.equal(beam.claimed, false, `${beam.id}: never moved - declines are not consent`);
  }
  // the asker was TOLD about refusals (in a later prompt's memory), and the
  // everyone-declined release reached it
  const pipPrompts = caller.prompts.filter((x) => x.me === "Pip").map((x) => x.prompt).join("\n");
  assert.match(pipPrompts, /declined your ask for beam-\d/, "asker sees who declined");
  assert.match(pipPrompts, /everyone declined your ask/, "asker is released when all decline");
  // refusals are visible on the characters' own panel lines
  const decliner = crew.statuses().find((s) => /declined the ask/.test(s.detail));
  assert.ok(decliner, "a decliner's panel line shows the refusal");
});

test("decline does not stall the crew when another character does want the lift", async () => {
  const clock = { t: 10_000 };
  // Gus declines every ask once, then helps the next one; others cooperate.
  const script: Script = (me, prompt, { callsBy }) => {
    if (me === "Gus" && (callsBy.get("Gus") ?? 0) === 1) {
      const asks = openAsks(prompt);
      if (asks.length) return { action: "decline", piece: asks[0], reason: "Gus is busy in his head" };
    }
    return cooperative(me, prompt, { callsBy });
  };
  const p = new BridgePuzzle(CREW, 7);
  const caller = mindCaller(script);
  const crew = new MindfulCrew(caller, () => clock.t);
  p.setController(crew);
  const t = await runWithMinds(p, crew, clock, 400);
  assert.equal(p.status, "complete", `t=${t}`);
  const gus = crew.statuses().find((s) => s.name === "Gus")!;
  assert.equal(gus.state, "active");
});
