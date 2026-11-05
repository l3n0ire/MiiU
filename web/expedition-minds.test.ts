import { test } from "node:test";
import assert from "node:assert/strict";
import { PassMinds } from "./expedition-minds.ts";
import { Expedition, type CrewMember } from "./expedition-engine.ts";
import type { JsonCaller } from "../server/llm-json.ts";

const CREW: CrewMember[] = [
  { id: "a", name: "Pip", color: "#ff7a59" },
  { id: "b", name: "Marlo", color: "#4a90d9" },
  { id: "c", name: "Juniper", color: "#b36bd6" },
  { id: "d", name: "Gus", color: "#3fb57a" },
];

type Move = { action: "fetch" | "scout" | "share" | "wait"; crate: string; reason: string };
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

async function runWithMinds(p: Expedition, clock: { t: number }, maxSeconds: number): Promise<number> {
  let t = 0;
  const dt = 0.05;
  while (t < maxSeconds && p.status === "running") {
    for (let i = 0; i < 20 && p.status === "running"; i++) { p.tick(dt); t += dt; }
    clock.t += 2000; // let per-mind cooldowns pass between flushes
    await flush();
  }
  return t;
}

// A sensible scripted crew: Pip scouts first, shares what he finds; everyone
// fetches the first unclaimed crate; nobody is coached on values - the script
// only parses the same prompt a real model would get.
const cooperative: Script = (me, prompt) => {
  if (prompt.includes('"share" to tell the crew about the pass you found')) {
    return { action: "share", crate: "", reason: `${me} tells the crew about the pass` };
  }
  if (me === "Pip" && prompt.includes('"scout" to walk up to the ridge') && !prompt.includes("You KNOW a hidden pass")) {
    return { action: "scout", crate: "", reason: `${me} goes looking for a shorter way` };
  }
  const open = [...prompt.matchAll(/^- (crate-\d+) at .* - unclaimed/gm)].map((m) => m[1]);
  if (open.length) return { action: "fetch", crate: open[0], reason: `${me} grabs ${open[0]}` };
  return { action: "wait", crate: "", reason: `${me} waits` };
};

test("each mii decides for itself; a discovery is scouted, shared, then used by others", async () => {
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  await runWithMinds(p, clock, 900);
  assert.equal(p.status, "complete");
  assert.equal(p.deliveredCount(), 4);
  const s = p.snapshot();
  assert.equal(s.stats.discoveries.length, 1, "exactly one discovery");
  assert.equal(s.stats.discoveries[0].name, "Pip");
  assert.equal(s.stats.shares.length, 1);
  assert.equal(s.stats.shares[0].name, "Pip");
  // others benefited: at least one route update credited to Pip's share, and
  // after the share every mii's view shows the pass
  assert.ok(s.stats.routeUpdates.length >= 1);
  assert.ok(s.stats.routeUpdates.every((u) => u.via === "Pip"));
  for (const m of p.members) {
    assert.ok(p.decisionViewFor(m.id).passIKnow, `${m.name} knows the pass after the share`);
  }
  assert.ok(minds.stats().calls > 4, "several independent decisions happened");
});

test("prompt privacy: no pass location before discovery or share, not even via route lengths", async () => {
  // Phase 1: a controlled first dispatch - every mii is still at its spawn,
  // nobody has discovered anything. Clock starts past the initial cooldown.
  const clock = { t: 10_000 };
  const p = new Expedition(CREW, 7);
  const l = p.layout;
  const passCoord = `(${l.rx0},${l.passY})`;
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  p.tick(0.5); // one dispatch round, no wandering yet
  await flush();
  assert.equal(caller.prompts.length, 4, "every free mii got exactly one prompt");
  for (const q of caller.prompts) {
    assert.ok(!q.prompt.includes("hidden pass at"), `${q.me} saw a pass location before any discovery`);
    assert.ok(!q.prompt.includes(passCoord), `${q.me} saw the pass coordinates`);
    // every quoted route must equal the PUBLIC (detour) route length from
    // that mii's own position - never the shorter pass route
    const member = p.members.find((m) => m.name === q.me)!;
    const quoted = [...q.prompt.matchAll(/- (crate-\d+) at .*?~(\d+) tiles away/g)];
    assert.ok(quoted.length >= 1, `${q.me} got quoted crate routes`);
    for (const [, cid, n] of quoted) {
      const crate = p.crates.find((c) => c.id === cid)!;
      const publicLen = lenOf(p.pathFor(null, member.pos, crate.pos), member.pos);
      assert.equal(Number(n), publicLen, `${q.me}/${cid}: quoted route must be the public one`);
      const withKnowledge = (p as unknown as { discovered: Set<string> }).discovered;
      withKnowledge.add(member.id);
      const passLen = lenOf(p.pathFor(member.id, member.pos, crate.pos), member.pos);
      withKnowledge.delete(member.id);
      if (passLen !== null && passLen !== publicLen) {
        assert.notEqual(Number(n), passLen, `${q.me}/${cid}: quoted route leaked the pass route`);
      }
    }
  }
  // Phase 2: run until Pip shares. Before the share, only Pip's prompts may
  // contain the pass coordinates; Marlo (who never scouts) must never see
  // even the words "hidden pass at" before the share.
  let t = 0;
  while (t < 900 && p.snapshot().pass.sharedBy === null && p.status === "running") {
    for (let i = 0; i < 20 && p.snapshot().pass.sharedBy === null; i++) { p.tick(0.05); t += 0.05; }
    clock.t += 2000;
    await flush();
  }
  assert.equal(p.snapshot().pass.sharedBy, "Pip", "the share happened");
  const coordsMentions = caller.prompts.filter((q) => q.prompt.includes(passCoord));
  assert.ok(coordsMentions.length > 0, "Pip's prompts contained the coordinates after his discovery");
  for (const q of coordsMentions) {
    assert.equal(q.me, "Pip", `${q.me} saw pass coordinates before the share`);
  }
  const marloEarly = caller.prompts.filter((q) => q.me === "Marlo").slice(0, 3);
  for (const q of marloEarly) {
    assert.ok(!q.prompt.includes("hidden pass at"), "Marlo got no pass location");
    assert.ok(!q.prompt.includes("You KNOW a hidden pass"), "Marlo got no pass knowledge");
  }
});

function lenOf(path: { x: number; y: number }[] | null, from?: { x: number; y: number }): number | null {
  if (!path) return null;
  let len = 0;
  let cur = from ?? path[0];
  for (const n of path) { len += Math.hypot(n.x - cur.x, n.y - cur.y); cur = n; }
  return Math.round(len);
}

test("budget exhaustion fails the run - no silent built-in completion", async () => {
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t, maxCalls: 2 });
  p.setController(minds);
  await runWithMinds(p, clock, 900);
  assert.equal(p.status, "failed");
  assert.match(p.failureReason ?? "", /call budget/);
  assert.ok(p.deliveredCount() < 4, "the task did NOT complete on built-in logic");
  const s = p.snapshot();
  assert.ok(s.log.some((l) => l.text.includes("failed to accomplish the task")));
  // frozen: further ticks change nothing
  const before = JSON.stringify(p.snapshot().members);
  for (let i = 0; i < 50; i++) p.tick(0.05);
  assert.equal(JSON.stringify(p.snapshot().members), before);
  assert.equal(minds.budgetExhausted(), true);
});

test("a model error falls back just that mii to built-in, named per character; run continues", async () => {
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  const caller = mindCaller(cooperative, { failFor: "Gus" });
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  await runWithMinds(p, clock, 900);
  assert.equal(p.status, "complete", "the rest of the crew finished");
  const st = minds.statuses();
  const gus = st.find((q) => q.name === "Gus")!;
  assert.equal(gus.state, "fallback");
  assert.match(gus.detail, /built-in \(connection refused; the model keeps retrying\)/);
  assert.ok(st.filter((q) => q.state === "fallback").length === 1, "only Gus fell back");
});

test("a reply that arrives after the 30s timeout is stale and ignored", async () => {
  const clock = { t: 10_000 }; // past the initial per-mind cooldown so the call starts on the first dispatch
  const p = new Expedition(CREW, 7);
  let resolveLate: ((v: Move) => void) | null = null;
  const caller = {
    provider: "ollama" as const,
    model: "fake-minds",
    async callJson<T>(prompt: string): Promise<T> {
      if (prompt.includes("You are Pip.")) {
        return new Promise<T>((res) => { resolveLate = res as (v: Move) => void; });
      }
      return { action: "wait", crate: "", reason: "waiting" } as T;
    },
  };
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  p.tick(0.5); // dispatch: Pip's call starts (hangs)
  await flush();
  clock.t += 31_000; // pass the 30s timeout
  p.tick(0.5);
  await flush();
  const pip = minds.statuses().find((q) => q.name === "Pip")!;
  assert.equal(pip.state, "fallback");
  assert.match(pip.detail, /no answer after 30s/);
  // the late reply arrives now - it must not resurrect the mind or commit a move
  (resolveLate as unknown as (v: Move) => void)({ action: "fetch", crate: "crate-0", reason: "late answer" });
  await flush();
  const pip2 = minds.statuses().find((q) => q.name === "Pip")!;
  assert.equal(pip2.state, "fallback");
  assert.equal(pip2.lastReason, null, "stale reply touched nothing");
});

test("newPuzzle resets minds and budget; an adjustable limit applies to the next run", async () => {
  const clock = { t: 0 };
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t, maxCalls: 1 });
  const p1 = new Expedition(CREW, 7);
  p1.setController(minds);
  await runWithMinds(p1, clock, 900);
  assert.equal(p1.status, "failed");
  // restart the same layout with a bigger budget
  minds.newPuzzle(60);
  const p2 = new Expedition(CREW, 7);
  p2.setController(minds);
  await runWithMinds(p2, clock, 900);
  assert.equal(p2.status, "complete", "same layout completes with a bigger budget");
  assert.ok(minds.stats().maxCalls === 60);
});

test("a reply in flight when the budget runs out cannot mutate the failed run (PR43-bypass analog)", async () => {
  const clock = { t: 10_000 };
  const p = new Expedition(CREW, 7);
  let resolveLate: ((v: Move) => void) | null = null;
  const caller = {
    provider: "ollama" as const,
    model: "fake-minds",
    async callJson<T>(prompt: string): Promise<T> {
      if (prompt.includes("You are Pip.")) {
        return new Promise<T>((res) => { resolveLate = res as (v: Move) => void; });
      }
      return { action: "wait", crate: "", reason: "waiting" } as T;
    },
  };
  const minds = new PassMinds(caller, { now: () => clock.t, maxCalls: 2 });
  p.setController(minds);
  // run until the budget exhausts and the engine declares failure while Pip's
  // call is still hanging (no generation bump happens on budget failure)
  let t = 0;
  while (t < 120 && p.status === "running") {
    for (let i = 0; i < 20 && p.status === "running"; i++) { p.tick(0.05); t += 0.05; }
    clock.t += 2000;
    await flush();
  }
  assert.equal(p.status, "failed", "budget exhaustion failed the run with a call in flight");
  assert.ok(resolveLate, "Pip's call was still in flight at failure");
  const frozen = JSON.stringify(p.snapshot().members);
  const deliveredBefore = p.deliveredCount();
  const callsBefore = minds.stats().calls;
  const statusesBefore = JSON.stringify(minds.statuses());
  // the in-flight reply resolves AFTER the failure
  (resolveLate as unknown as (v: Move) => void)({ action: "fetch", crate: "crate-0", reason: "late answer" });
  await flush();
  clock.t += 5000;
  // pause/resume churn (the Dismiss+Resume analog) must not revive anything
  p.paused = true; p.paused = false;
  for (let i = 0; i < 100; i++) p.tick(0.05);
  await flush();
  assert.equal(p.status, "failed", "late reply + resume did not resurrect the run");
  assert.equal(p.deliveredCount(), deliveredBefore, "no crate finished under the failure label");
  assert.equal(JSON.stringify(p.snapshot().members), frozen, "the failed run stayed frozen");
  assert.equal(minds.stats().calls, callsBefore, "no further model calls after failure");
  assert.equal(JSON.stringify(minds.statuses()), statusesBefore, "late reply did not mutate crew-panel mind state after failure");
  // and a restart discards the stale reply via the generation bump
  minds.newPuzzle(60);
  const p2 = new Expedition(CREW, 7);
  p2.setController(minds);
  p2.tick(0.5);
  await flush();
  const pip = minds.statuses().find((q) => q.name === "Pip")!;
  assert.notEqual(pip.lastReason, "late answer", "stale pre-failure reply did not carry into the restart");
});

test("carried crates never leak ridge-column coordinates into prompts (review repro)", async () => {
  // sharing OFF: Pip finds the pass and uses it privately. While he carries a
  // crate through it, other miis must see the crate as carried - never its
  // live coordinates (which would sit on ridge tiles).
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  p.setSharing(false);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  const [rx0, rx1] = [p.layout.rx0, p.layout.rx1];
  let sawCrateOnRidge = false;
  let t = 0;
  const dt = 0.05;
  while (t < 900 && p.status === "running") {
    for (let i = 0; i < 20 && p.status === "running"; i++) {
      p.tick(dt); t += dt;
      if (p.crates.some((c) => !c.delivered && c.pos.x >= rx0 && c.pos.x <= rx1 + 0.5)) sawCrateOnRidge = true;
    }
    clock.t += 2000;
    await flush();
  }
  assert.equal(p.status, "complete");
  assert.equal(p.snapshot().pass.sharedBy, null, "pass stayed private (sharing off)");
  assert.equal(p.snapshot().pass.foundByAnyone, true, "Pip found the pass");
  assert.ok(sawCrateOnRidge, "a crate was carried across ridge tiles during the run");
  const carriedLines: string[] = [];
  for (const q of caller.prompts) {
    for (const line of q.prompt.split("\n")) {
      if (!line.startsWith("- crate-")) continue;
      const m = /at \((-?\d+),(-?\d+)\)/.exec(line);
      if (m) {
        assert.ok(Number(m[1]) > rx1, `${q.me} saw crate coordinates on/near the ridge: ${line}`);
      } else if (line.includes("being carried")) {
        carriedLines.push(line);
      }
    }
  }
  assert.ok(carriedLines.length > 0, "carried crates were rendered as carried, without coordinates");
});

test("the budget wall latches in the same tick - no walk, delivery or win after it", async () => {
  const clock = { t: 10_000 };
  const p = new Expedition(CREW, 7);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t, maxCalls: 6 }); // enough to be mid-run when the wall hits
  p.setController(minds);
  let sawWall = false;
  for (let i = 0; i < 20000 && p.status !== "failed"; i++) {
    const posBefore = p.snapshot().members.map((m) => [m.x, m.y]);
    const delivered = p.deliveredCount();
    p.tick(0.05);
    clock.t += 2000;
    await flush();
    if (minds.budgetExhausted() && !sawWall) {
      sawWall = true;
      assert.equal(p.status, "failed", "failure latched in the same tick as the exhaustion attempt");
      // positions and deliveries are the advance mutations: none after the wall
      // (a paid decision applied earlier in the same dispatch round is the
      // final authorized call result, not a post-wall advance)
      assert.deepEqual(p.snapshot().members.map((m) => [m.x, m.y]), posBefore, "no member moved after the wall");
      assert.equal(p.deliveredCount(), delivered, "no delivery landed after the wall");
    }
  }
  assert.ok(sawWall, "the wall was hit");
});

test("sharing OFF prompts explain the restriction and never offer a private discovery to share", async () => {
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  p.setSharing(false);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t, maxCalls: 60 });
  p.setController(minds);
  await runWithMinds(p, clock, 900);
  assert.equal(p.status, "complete"); // scripted regression, not a real-model result
  assert.equal(p.snapshot().pass.sharedBy, null);
  assert.deepEqual(p.snapshot().pass.knownBy, ["Pip"]);
  const discoverer = caller.prompts.filter((q) => q.prompt.includes("You found this pass YOURSELF"));
  assert.ok(discoverer.length > 0, "exercised the previously contradictory private-discovery prompt");
  for (const q of caller.prompts) {
    assert.match(q.prompt, /Sharing is OFF for this run\. Do not choose "share"/);
    assert.ok(!q.prompt.includes('It is your choice: "share"'));
    assert.ok(!q.prompt.includes('"share" to tell the crew'));
    if (q.me !== "Pip") assert.ok(!q.prompt.includes(`(${p.layout.rx0},${p.layout.passY})`), "private location stays hidden");
  }
  for (const q of discoverer) assert.match(q.prompt, /You cannot share the pass; use it privately to fetch supplies, or wait/);
});

test("sharing ON still offers the discoverer a genuine share-or-keep choice", async () => {
  const clock = { t: 0 };
  const p = new Expedition(CREW, 7);
  const caller = mindCaller(cooperative);
  const minds = new PassMinds(caller, { now: () => clock.t });
  p.setController(minds);
  await runWithMinds(p, clock, 900);
  const discoverer = caller.prompts.filter((q) => q.prompt.includes("You found this pass YOURSELF"));
  assert.ok(discoverer.length > 0);
  for (const q of discoverer) {
    assert.ok(q.prompt.includes('It is your choice: "share"'));
    assert.ok(q.prompt.includes('"share" to tell the crew'));
    assert.ok(!q.prompt.includes("Sharing is OFF"));
  }
  assert.equal(p.snapshot().pass.sharedBy, "Pip");
});
