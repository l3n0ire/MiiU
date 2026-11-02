import { test } from "node:test";
import assert from "node:assert/strict";
import { MindfulCrew, type MindScenario } from "./puzzle-minds.ts";
import { LongCrossing, type CrewMember } from "./crossing-engine.ts";
import type { JsonCaller } from "../server/llm-json.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

const CROSSING_SCENARIO: MindScenario = {
  system: "crossing TWO rivers together: bridge the first river, ferry materials across it, then bridge the second river so the whole crew can reach the flag",
  intro: "The crew must cross TWO rivers with a rocky island between them. First build bridge 1 across the near river. Then materials can reach the island and the far bridge: bridge 2's block and one of its beams are lying on the island, but bridge 2's OTHER beam is still on this home bank - two miis must FERRY it across the finished bridge 1. Each gap cell needs one piece carried over and placed. Blocks need one carrier. Beams are heavy and only move when TWO miis carry them together. Far gaps are out of reach until the path to them exists.",
  waitingNote: "the way to them does not exist yet - bridge 1 and the nearer far gaps come first",
};

type Move = { action: "claim" | "help" | "decline" | "wait"; piece: string; reason: string };

const flush = () => new Promise((r) => setTimeout(r, 0));

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

// Same independent-character policy as the bridge puzzle tests: answer an
// open beam ask first, else claim an unannounced placeable block, else claim
// a lone beam. Nobody coordinates them but the shared board.
const cooperative = (me: string, prompt: string): Move => {
  const asks = openAsks(prompt);
  if (asks.length) return { action: "help", piece: asks[0], reason: `${me} answers the call for ${asks[0]}` };
  const taken = new Set(announcedBlocks(prompt));
  const free = placeable(prompt).filter((p) => !p.heavy && !taken.has(p.id));
  if (free.length) return { action: "claim", piece: free[0].id, reason: `${me} grabs ${free[0].id}` };
  const beam = placeable(prompt).find((p) => p.heavy);
  if (beam) return { action: "claim", piece: beam.id, reason: `${me} asks for a partner on ${beam.id}` };
  return { action: "wait", piece: "", reason: `${me} waits` };
};

test("autonomous minds finish the two-river crossing; prompts brief the scenario", async () => {
  const clock = { t: 0 };
  const p = new LongCrossing(CREW, 7);
  const callsBy = new Map<string, number>();
  const prompts: string[] = [];
  const caller: JsonCaller & { calls: number } = {
    provider: "ollama",
    model: "fake-minds",
    calls: 0,
    async callJson<T>(prompt: string, _schema: object): Promise<T> {
      caller.calls++;
      prompts.push(prompt);
      const me = /You are (\w+)\./.exec(prompt)?.[1] ?? "?";
      callsBy.set(me, (callsBy.get(me) ?? 0) + 1);
      return cooperative(me, prompt) as T;
    },
  };
  const crew = new MindfulCrew(caller, () => clock.t, CROSSING_SCENARIO);
  p.setController(crew);

  let t = 0;
  const dt = 0.05;
  const status = () => p.status;
  while (t < 900 && status() !== "complete") {
    for (let i = 0; i < 20 && status() !== "complete"; i++) { p.tick(dt); t += dt; }
    clock.t += 2000;
    await flush();
  }
  assert.equal(p.status, "complete", `minds finished in ${t}s, ${p.placedCount()}/6 placed, ${caller.calls} calls`);
  assert.equal(p.placedCount(), 6);
  // every character really decided for itself - no single mind ran the crew
  assert.ok(callsBy.size >= 3, `decisions spread across characters: ${[...callsBy.keys()]}`);
  // the scenario briefing really reached the model: two rivers + ferrying
  const first = prompts[0] ?? "";
  assert.ok(first.includes("TWO rivers"), "intro describes both rivers");
  assert.ok(first.includes("FERRY"), "intro describes the ferry beam");
  assert.ok(/on bridge [12]/.test(prompts[prompts.length - 1] ?? ""), "pieces tagged by bridge");
  // the aggregate call budget was respected
  assert.ok(caller.calls <= 40, `${caller.calls} calls within the 40-call puzzle budget`);
});

test("minds cannot start a far piece before bridge 1 - rejection is fed back, not silently dropped", async () => {
  const clock = { t: 0 };
  const p = new LongCrossing(CREW, 7);
  const ferry = p.pieces.find((q) => q.bridge === 1 && q.heavy && q.home.x < p.layout.rivers[0].x0)!;
  const caller: JsonCaller = {
    provider: "ollama",
    model: "fake-minds",
    async callJson<T>(prompt: string): Promise<T> {
      // every character insists on the unreachable ferry beam, forever
      void prompt;
      return { action: "claim", piece: ferry.id, reason: "stubborn" } as T;
    },
  };
  const crew = new MindfulCrew(caller, () => clock.t, CROSSING_SCENARIO);
  p.setController(crew);
  let t = 0;
  for (let i = 0; i < 400; i++) {
    p.tick(0.05); t += 0.05;
    clock.t += 100;
    await flush();
  }
  assert.equal(ferry.state, "idle", "the unreachable ferry beam never started");
  assert.equal(p.placedCount(), 0, "no magic placement");
  void t;
});
