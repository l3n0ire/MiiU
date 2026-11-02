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

type Move = { action: "claim" | "help" | "wait"; piece: string; reason: string };
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
