import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TUNING, applyAction, ensureSecrets, gameViewFor, knownSecrets, maybeStartFestival,
  removeFromGame, resolveDuePledges, resolveFestival,
  EXPOSE_WITNESS_COST, EXPOSE_LEAKER_COST, PLEDGE_BROKEN_COST, PLEDGE_KEPT_GAIN, SWITCH_CLOSE_COST,
  type ActionContext,
} from "./game.ts";
import { getRel, migrateWorld, seedWorld, type World } from "./world.ts";
import { USER_ID, type LLM } from "./llm.ts";
import { Sim } from "./sim.ts";

const stubLlm: LLM = {
  model: "stub",
  generateLine: async (speaker) => ({ says: `${speaker.name} says hi`, wants_to_leave: false, action: { kind: "none", candidate: "", secret: 0, to: "" } }),
  summarizeConversation: async (members) => ({ outcomes: members.map((m) => ({ name: m.name, memory: "", mood: "neutral" as const, facts: [] })), pairs: [] }),
  generateReactions: async (_e, chars) => chars.map((c) => ({ name: c.name, says: "wow", mood: "happy" as const, memory: "x" })),
  generateEvent: async () => { throw new Error("unused"); },
  generateResident: async () => { throw new Error("unused"); },
};

const TUNING = { ...DEFAULT_TUNING, campaignMs: 60_000, cooldownMs: 60_000, tellWindowMs: 30_000 };

function freshWorld(): World {
  const w = seedWorld();
  ensureSecrets(w);
  return w;
}
const names = (w: World) => w.characters.map((c) => c.name);
function ctx(w: World, ...ids: string[]): ActionContext {
  const present = ids.map((id) => ({ id, name: id === USER_ID ? "You" : w.characters.find((c) => c.id === id)!.name }));
  return { present, tuning: TUNING };
}
function startRace(w: World) {
  const text = maybeStartFestival(w, TUNING);
  assert.ok(text, "race should start on a 4-resident island");
  return w.game.festival!;
}
const voterOf = (w: World) => w.characters.find((c) => !w.game.festival!.candidates.includes(c.id))!;
const candName = (w: World, i: number) => w.characters.find((c) => c.id === w.game.festival!.candidates[i])!.name;

test("festival: starts with 2 candidates + voters; skips tiny islands; respects clock", () => {
  const w = freshWorld();
  const f = startRace(w);
  assert.equal(f.status, "campaigning");
  assert.equal(f.candidates.length, 2);
  assert.equal(f.deadline, w.game.clockMs + TUNING.campaignMs);
  assert.equal(maybeStartFestival(w, TUNING), null, "no second race while campaigning");
  // resolution waits for the game clock, not the wall clock
  assert.equal(resolveFestival(w, TUNING), null);
  w.game.clockMs = f.deadline;
  const text = resolveFestival(w, TUNING);
  assert.match(text!, /flopped/); // nobody backed anyone
  assert.equal(w.game.festival!.status, "flopped");
  // cooldown gates the next race
  assert.equal(maybeStartFestival(w, TUNING), null);
  w.game.clockMs = w.game.festival!.nextAt!;
  assert.ok(maybeStartFestival(w, TUNING));
  // two residents cannot hold a race
  const tiny = seedWorld();
  tiny.characters = tiny.characters.slice(0, 2);
  ensureSecrets(tiny);
  assert.equal(maybeStartFestival(tiny, TUNING), null);
});

test("endorsements: legal moves, repeat drop, close-bond switch cost, neutral switch free", () => {
  const w = freshWorld();
  startRace(w);
  const v = voterOf(w);
  const cand = w.characters.find((c) => c.id === w.game.festival!.candidates[0])!;
  const other = w.characters.find((c) => c.id === w.game.festival!.candidates[1])!;
  // candidates cannot endorse
  assert.equal(applyAction(w, cand.id, { kind: "endorse", candidate: other.name }, ctx(w, cand.id, v.id)).kind, "none");
  // voter endorses
  const r1 = applyAction(w, v.id, { kind: "endorse", candidate: cand.name }, ctx(w, v.id, other.id));
  assert.equal(r1.kind, "endorse");
  assert.match(r1.event!, /endorsed/);
  assert.equal(w.game.festival!.endorsements[v.id], cand.id);
  // repeat endorsement of the same candidate is dropped (no event farming)
  assert.equal(applyAction(w, v.id, { kind: "endorse", candidate: cand.name }, ctx(w, v.id, other.id)).kind, "none");
  // neutral switch: no cost
  const before = getRel(w, v.id, cand.id).affinity;
  const r2 = applyAction(w, v.id, { kind: "switch", candidate: other.name }, ctx(w, v.id, other.id));
  assert.equal(r2.kind, "switch");
  assert.equal(getRel(w, v.id, cand.id).affinity, before);
  // close-bond switch: costs SWITCH_CLOSE_COST
  const rel = getRel(w, v.id, other.id);
  rel.label = "friend";
  rel.affinity = 60;
  const r3 = applyAction(w, v.id, { kind: "switch", candidate: cand.name }, ctx(w, v.id, cand.id));
  assert.match(r3.note!, /close bond/);
  assert.equal(getRel(w, v.id, other.id).affinity, 60 + SWITCH_CLOSE_COST);
});

test("secrets: tell is one-on-one only, transfers knowledge with chain, no re-tell", () => {
  const w = freshWorld();
  const [a, b, c] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;
  const idx = () => knownSecrets(w, a.id).indexOf(secret) + 1;
  // a group tell is dropped: the content must never land in a group transcript
  assert.equal(applyAction(w, a.id, { kind: "tell", secret: idx(), to: b.name }, ctx(w, a.id, b.id, c.id)).kind, "none");
  assert.ok(!secret.knownBy.includes(b.id));
  // one-on-one works
  const r = applyAction(w, a.id, { kind: "tell", secret: idx(), to: b.name }, ctx(w, a.id, b.id));
  assert.equal(r.kind, "tell");
  assert.ok(secret.knownBy.includes(b.id));
  assert.equal(secret.toldBy[b.id], a.id);
  assert.ok(b.memories.some((m) => m.includes(secret.text)), "told resident remembers the content");
  // telling someone who already knows is dropped
  assert.equal(applyAction(w, a.id, { kind: "tell", secret: idx(), to: b.name }, ctx(w, a.id, b.id)).kind, "none");
  // an index past the speaker's own known list is dropped (c knows only their own secret)
  assert.equal(knownSecrets(w, c.id).length, 1);
  assert.equal(applyAction(w, c.id, { kind: "tell", secret: 2, to: b.name }, ctx(w, c.id, b.id)).kind, "none");
});

test("secrets: exposure is public, priced, single-use, and reveals the chain to the subject", () => {
  const w = freshWorld();
  const [a, b, c, d] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;
  applyAction(w, a.id, { kind: "tell", secret: 1, to: b.name }, ctx(w, a.id, b.id)); // a -> b
  const bIdx = knownSecrets(w, b.id).indexOf(secret) + 1;
  applyAction(w, b.id, { kind: "tell", secret: bIdx, to: c.name }, ctx(w, b.id, c.id)); // b -> c
  const cIdx = knownSecrets(w, c.id).indexOf(secret) + 1;
  const before = Object.fromEntries(w.characters.map((x) => [x.id, getRel(w, a.id, x.id).affinity]));
  const r = applyAction(w, c.id, { kind: "expose", secret: cIdx }, ctx(w, c.id, d.id));
  assert.equal(r.kind, "expose");
  assert.match(r.event!, new RegExp(secret.text.slice(0, 20)));
  assert.ok(secret.exposed);
  // priced: -10 with every other resident, -20 with the leaker
  assert.equal(getRel(w, a.id, b.id).affinity, before[b.id] + EXPOSE_WITNESS_COST);
  assert.equal(getRel(w, a.id, d.id).affinity, before[d.id] + EXPOSE_WITNESS_COST);
  assert.equal(getRel(w, a.id, c.id).affinity, before[c.id] + EXPOSE_LEAKER_COST);
  // leak discovery: the subject privately learns the tell-chain
  const mem = a.memories.find((m) => m.startsWith("(exposed)"))!;
  assert.ok(mem.includes(`${b.name} told ${c.name}`), `chain revealed: ${mem}`);
  // single-use
  assert.equal(applyAction(w, b.id, { kind: "expose", secret: bIdx }, ctx(w, b.id, d.id)).kind, "none");
});

test("promises: keep resolves at the festival deadline, telling early breaks it", () => {
  const w = freshWorld();
  const f = startRace(w);
  const [a, b] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;
  const r = applyAction(w, a.id, { kind: "promise_keep", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  assert.equal(r.kind, "promise_keep");
  const pledge = w.game.pledges[0];
  assert.equal(pledge.deadline, f.deadline, "keep-promises anchor to the festival deadline");
  // duplicate pledge (even after resolution) is blocked: no trust farming
  assert.equal(applyAction(w, a.id, { kind: "promise_keep", secret: 1, to: b.name }, ctx(w, a.id, b.id)).kind, "none");
  // telling anyone before the deadline breaks it immediately
  const before = getRel(w, a.id, b.id).affinity;
  applyAction(w, a.id, { kind: "tell", secret: 1, to: w.characters[2].name }, ctx(w, a.id, w.characters[2].id));
  assert.equal(pledge.status, "broken");
  assert.equal(getRel(w, a.id, b.id).affinity, before + PLEDGE_BROKEN_COST);
  assert.ok(getRel(w, a.id, b.id).history.some((h) => h.includes("broke a promise")));
});

test("promises: kept pledge pays once; tell-promise fulfilled by delivery, broken at deadline", () => {
  const w = freshWorld();
  startRace(w);
  const [a, b] = w.characters;
  // keep-promise surviving to the deadline
  applyAction(w, a.id, { kind: "promise_keep", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  w.game.clockMs = w.game.festival!.deadline;
  const before = getRel(w, a.id, b.id).affinity;
  assert.equal(resolveDuePledges(w).length, 1);
  assert.equal(w.game.pledges[0].status, "kept");
  assert.equal(getRel(w, a.id, b.id).affinity, before + PLEDGE_KEPT_GAIN);
  assert.equal(resolveDuePledges(w).length, 0, "settlement fires exactly once");
  // tell-promise: delivered in time
  const secret = w.game.secrets.find((s) => s.subject === b.id)!;
  const bIdx = knownSecrets(w, b.id).indexOf(secret) + 1;
  applyAction(w, b.id, { kind: "promise_tell", secret: bIdx, to: a.name }, ctx(w, b.id, a.id));
  const p2 = w.game.pledges[1];
  const r = applyAction(w, b.id, { kind: "tell", secret: bIdx, to: a.name }, ctx(w, b.id, a.id));
  assert.equal(r.kind, "tell");
  assert.equal(p2.status, "kept");
  // tell-promise expiring undelivered
  applyAction(w, b.id, { kind: "promise_tell", secret: bIdx, to: w.characters[2].name }, ctx(w, b.id, w.characters[2].id));
  w.game.clockMs = w.game.pledges[2].deadline;
  resolveDuePledges(w);
  assert.equal(w.game.pledges[2].status, "broken");
});

test("privacy: a resident's game view never contains secrets they do not know", () => {
  const w = freshWorld();
  const [a, b, c] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;
  applyAction(w, a.id, { kind: "tell", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  // c knows nothing: neither the content nor the tell-chain may surface in their prompt
  const view = gameViewFor(w, c.id, TUNING);
  assert.ok(!view.includes(secret.text), "uninvolved resident must not see the content");
  assert.ok(!view.includes(a.name) || !view.includes("secret"), "uninvolved resident gets no secret context");
  // the knower sees it numbered; the subject sees their own
  assert.ok(gameViewFor(w, b.id, TUNING).includes(secret.text));
  assert.ok(gameViewFor(w, a.id, TUNING).includes(secret.text));
  // even after exposure, uninvolved prompts carry only the public marker path
  const cIdx = knownSecrets(w, b.id).indexOf(secret) + 1;
  applyAction(w, b.id, { kind: "expose", secret: cIdx }, ctx(w, b.id, c.id));
  assert.ok(!knownSecrets(w, c.id).some((s) => s.id === secret.id), "exposure does not add to a witness's private ledger");
});

test("migration: game state survives a save/load round-trip, dangling refs dropped", () => {
  const w = freshWorld();
  startRace(w);
  const v = voterOf(w);
  applyAction(w, v.id, { kind: "endorse", candidate: candName(w, 0) }, ctx(w, v.id));
  const [a, b] = w.characters;
  applyAction(w, a.id, { kind: "tell", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  const loaded = migrateWorld(JSON.parse(JSON.stringify(w)));
  assert.equal(loaded.game.festival!.status, "campaigning");
  assert.equal(loaded.game.festival!.endorsements[v.id], w.game.festival!.candidates[0]);
  const secret = loaded.game.secrets.find((s) => s.subject === a.id)!;
  assert.deepEqual(secret.knownBy.sort(), [a.id, b.id].sort());
  assert.equal(secret.toldBy[b.id], a.id);
  // a resident who left takes their votes, secrets and pledges with them
  const removed = loaded.characters.pop()!;
  removeFromGame(loaded, removed.id);
  const reloaded = migrateWorld(JSON.parse(JSON.stringify(loaded)));
  assert.ok(!reloaded.game.festival!.candidates.includes(removed.id));
  assert.ok(!reloaded.game.secrets.some((s) => s.subject === removed.id));
});

test("player: residents can tell the player a secret and promise them things", () => {
  const w = freshWorld();
  startRace(w);
  const [a] = w.characters;
  const r = applyAction(w, a.id, { kind: "tell", secret: 1, to: "You" }, ctx(w, a.id, USER_ID));
  assert.equal(r.kind, "tell");
  assert.ok(w.game.secrets[0].knownBy.includes(USER_ID));
  const p = applyAction(w, a.id, { kind: "promise_keep", secret: 1, to: "You" }, ctx(w, a.id, USER_ID));
  assert.equal(p.kind, "promise_keep");
  assert.equal(w.game.pledges[0].promisee, USER_ID);
});

test("clock discipline: paused/closed time never counts toward deadlines", () => {
  const w = freshWorld();
  const f = startRace(w);
  const [a, b] = w.characters;
  applyAction(w, a.id, { kind: "promise_tell", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  const pledge = w.game.pledges[0];
  // Simulate a closed tab: wall time passes, the game clock does not.
  const clockAtClose = w.game.clockMs;
  const loaded = migrateWorld(JSON.parse(JSON.stringify(w)));
  assert.equal(loaded.game.clockMs, clockAtClose, "offline time does not advance the game clock");
  assert.equal(loaded.game.festival!.deadline, f.deadline, "festival deadline is unchanged across sessions");
  assert.equal(loaded.game.pledges[0].deadline, pledge.deadline, "pledge deadline is unchanged across sessions");
  // Nothing resolves until the GAME clock reaches the deadline, however long the tab was closed.
  assert.equal(resolveFestival(loaded, TUNING), null);
  assert.equal(resolveDuePledges(loaded).length, 0);
  loaded.game.clockMs = pledge.deadline - 1;
  assert.equal(resolveDuePledges(loaded).length, 0, "one sim-ms early is still active");
  loaded.game.clockMs = pledge.deadline;
  assert.equal(resolveDuePledges(loaded).length, 1);
});

test("derived context: watchers and later chats expose nothing private before exposure", () => {
  const w = freshWorld();
  const [a, b, c, d] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;
  applyAction(w, a.id, { kind: "tell", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  // No island event was produced by the tell (nothing for the news feed to carry).
  // A third party's prompt context excludes the content, the subject, and the tell-chain.
  for (const outsider of [c, d]) {
    const view = gameViewFor(w, outsider.id, TUNING);
    assert.ok(!view.includes(secret.text), `${outsider.name} must not see content`);
    assert.ok(!/told|secret/i.test(view) || !view.includes(a.name), `${outsider.name} must not see the chain`);
    assert.deepEqual(knownSecrets(w, outsider.id).filter((s) => s.subject === a.id), []);
  }
  // Even the witness list in the ledger is only visible through each resident's own view:
  // b's view lists the secret, c's does not - already covered; exposure flips it public.
  applyAction(w, b.id, { kind: "expose", secret: 1, to: c.name }, ctx(w, b.id, c.id));
  assert.ok(gameViewFor(w, c.id, TUNING).includes("[already public]") || !gameViewFor(w, c.id, TUNING).includes(secret.text));
});

// ---------- observer-channel privacy, migration hygiene, player referent (review on 0f3f32e) ----------

test("snapshot: broadcast redacts private ledger data but keeps observer fields", () => {
  const w = freshWorld();
  const sim = new Sim(w, () => {}, { llm: stubLlm });
  const [a, b, c] = w.characters;
  const secret = w.game.secrets.find((s) => s.subject === a.id)!;

  // legal one-on-one tell through the real ledger
  const r = applyAction(w, a.id, { kind: "tell", secret: 1, to: b.name }, ctx(w, a.id, b.id));
  assert.equal(r.kind, "tell");
  assert.equal(secret.exposed, false);

  const snap = sim.snapshot() as any;
  const wire = JSON.stringify({ type: "state", ...snap });
  assert.ok(!wire.includes(secret.text), "unexposed secret text must not reach clients");
  const bWire = snap.characters.find((x: any) => x.id === b.id);
  assert.ok(bWire.memories.every((m: string) => !m.startsWith("(secret)")), "tell records stay server-side");
  assert.ok(!("facts" in bWire), "facts are prompt substrate, not wire data");
  assert.equal(typeof bWire.personality, "string", "observer detail fields preserved");
  assert.ok(snap.characters.every((x: any) => Array.isArray(x.memories)));

  // organic memories still flow; organic copies of an unexposed secret do not
  c.memories.push("Saw a shooting star over the beach.");
  c.memories.push(`Overheard something: ${secret.text}`);
  const snap2 = sim.snapshot() as any;
  const cWire = snap2.characters.find((x: any) => x.id === c.id);
  assert.ok(cWire.memories.some((m: string) => m.includes("shooting star")), "ordinary observer memories kept");
  assert.ok(!JSON.stringify(snap2).includes(secret.text), "summarizer-style copies of the text are scrubbed too");

  // exposure is island news by design; the tell-chain the subject learns stays server-side
  const rx = applyAction(w, b.id, { kind: "expose", secret: 1 }, ctx(w, b.id, c.id));
  assert.equal(rx.kind, "expose");
  assert.ok(rx.event!.includes(secret.text), "exposure event is public by design");
  const aWire = (sim.snapshot() as any).characters.find((x: any) => x.id === a.id);
  assert.ok(
    aWire.memories.every((m: string) => !m.startsWith("(exposed)") && !m.includes("spread via")),
    "private tell-chain learning must not be broadcast",
  );
});

test("migrateWorld: candidate voters and ghost endorsements are dropped", () => {
  const w = freshWorld();
  const [a, b, c] = w.characters;
  const raw = JSON.parse(JSON.stringify(w));
  raw.game.festival = {
    status: "campaigning",
    candidates: [a.id, b.id],
    endorsements: { [a.id]: b.id, [c.id]: b.id, ghost: a.id, [c.id + "x"]: "nobody" },
    deadline: 100, winner: null, nextAt: null,
  };
  const m = migrateWorld(raw);
  assert.deepEqual(m.game.festival!.endorsements, { [c.id]: b.id }, "only known non-candidate voters backing real candidates survive");
});

test("gameViewFor + ledgers: the player renders in third person for resident readers", () => {
  const w = freshWorld();
  const [a, b] = w.characters;
  w.game.secrets.push({ id: "secX", subject: USER_ID, text: "The player once entered a pie contest.", knownBy: [a.id], toldBy: { [a.id]: null }, exposed: false });
  startRace(w);
  const pr = applyAction(w, a.id, { kind: "promise_keep", secret: 2, to: "You" }, ctx(w, a.id, USER_ID));
  assert.equal(pr.kind, "promise_keep");
  const view = gameViewFor(w, a.id, TUNING);
  assert.ok(view.includes("about the player"), view);
  assert.ok(view.includes("Promise you made: keep the secret about the player"), view);
  assert.ok(!view.includes("about you"), "prompt context must not call the player 'you'");
  const mem = w.characters.find((c) => c.id === a.id)!.memories.join("\n");
  assert.ok(!mem.includes(" promised you to "), mem);
  assert.ok(mem.includes(`promised the player to`), mem);
  // second resident's view of the same pledge also third-person
  const viewB = gameViewFor(w, b.id, TUNING);
  assert.ok(!viewB.includes("about you"), viewB);
});

test("provenance: tell-chat derived data is tagged, projected off the wire, kept in world", () => {
  const w = freshWorld();
  const events: any[] = [];
  const sim = new Sim(w, (e) => events.push(e), { llm: stubLlm, config: { autoEvents: false, spawning: false } });
  const [a, b] = w.characters;
  const rel = getRel(w, a.id, b.id);
  const chat = {
    members: [a, b], present: [a, b], pairs: [{ a, b, rel }], place: "Park",
    lines: [{ speaker: a.name, text: "psst" }],
    idx: 1, nextAt: 0, lastSpeaker: null, generating: false, finished: true, outcome: null,
    privateGame: true, // set by Sim when a ledger tell landed in this chat
  } as any;
  (sim as any).finishChat(chat, {
    outcomes: [{ name: a.name, memory: "whispered about the potluck", mood: "neutral" as const, facts: ["the cake was store-bought"] }],
    pairs: [{ a: a.name, b: b.name, affinity_delta: 2, relationship: "friend" as const }],
  });
  // World keeps everything for prompts/saves (server-side, knowledge-gated).
  assert.ok(a.memories.some((m) => m.startsWith("(private)")), "derived memory kept in world with provenance tag");
  assert.ok(rel.history.some((h) => h.startsWith("(private)")), "derived history kept in world with provenance tag");
  assert.ok(a.facts.includes("the cake was store-bought"), "facts stay in the world");
  // The wire projection drops them by provenance - no exact-text match needed.
  const snap = sim.snapshot() as any;
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes("whispered about the potluck"), "paraphrase without any secret text still excluded");
  assert.ok(!wire.includes("(private)"));
  const aWire = snap.characters.find((x: any) => x.id === a.id);
  assert.ok(!("facts" in aWire));
  const relWire = snap.relationships.find((r: any) => [r.a, r.b].sort().join("|") === [a.id, b.id].sort().join("|"));
  assert.ok(relWire.history.every((h: string) => !h.startsWith("(private)")));
  // The private chat's transcript never hits the event log either.
  const chatEv = events.find((e) => e.kind === "chat");
  assert.ok(chatEv && !("lines" in chatEv), "private-game chat event carries no transcript");
});

test("user-chat tell: plumbing flags privateGame, tags summaries/history, wire and event feed stay clean", async () => {
  const w = freshWorld();
  const [a] = w.characters;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const llm: LLM = {
    ...stubLlm,
    generateLine: async () => ({
      says: "psst, between us",
      wants_to_leave: false,
      action: { kind: "tell" as const, candidate: "", secret: 1, to: "Mitra" },
    }),
    summarizeConversation: async (members) => ({
      outcomes: members.map((m) => ({ name: m.name, memory: "confided to Mitra that his famous potluck cake was store-bought", mood: "neutral" as const, facts: [] })),
      pairs: [],
      player_bonds: [{ name: a.name, affinity_delta: 3, relationship: "friend" as const }],
    }),
  };
  const sim = new Sim(w, () => {}, { llm, config: { autoEvents: false, spawning: false, playerSpawning: false } });
  sim.startUserChat([a.id], "Mitra");
  sim.userChatMessage("hey");
  await sleep(30); // let pumpUserChat run the line + action through
  const chat = (sim as any).userChat;
  assert.equal(chat.privateGame, true, "pumpUserChat flags a chat where a resident told the player");
  sim.endUserChat();
  await sleep(30); // let the summary land
  // World keeps the derived data, provenance-tagged (prompts/saves stay full fidelity).
  assert.ok(a.memories.some((m) => m.startsWith("(private)") && m.includes("confided to Mitra")), a.memories.join("\n"));
  const bondHist = getRel(w, a.id, USER_ID).history.at(-1)!;
  assert.ok(bondHist.startsWith("(private)"), bondHist);
  // The wire projection drops the paraphrased summary and the bond history entry.
  const snap = sim.snapshot() as any;
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes("confided to Mitra"), "paraphrased tell summary must not reach the observer");
  assert.ok(!wire.includes("(private)"));
  const relWire = snap.relationships.find((r: any) => [r.a, r.b].includes(USER_ID));
  assert.ok(relWire && relWire.history.every((h: string) => !h.startsWith("(private)")));
  // And the event generator is fed no transcript from the private chat.
  assert.equal((sim as any).recentChats.at(-1).lines.length, 0);
});

test("event generator: private chats contribute no transcript, public chats still do", async () => {
  const w = freshWorld();
  const fed: string[] = [];
  const llm: LLM = {
    ...stubLlm,
    generateEvent: async (recentChats) => {
      fed.push(JSON.stringify(recentChats));
      return { headline: "Festival of crumbs", target: "everyone", gather: "nowhere" };
    },
  };
  const sim = new Sim(w, () => {}, { llm, config: { autoEvents: true, autoEventCooldown: 0, spawning: false, playerSpawning: false } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const [a, b] = w.characters;
  const rel = getRel(w, a.id, b.id);
  const mkChat = (privateGame: boolean, text: string) => ({
    members: [a, b], present: [a, b], pairs: [{ a, b, rel }], place: "Park",
    lines: [{ speaker: a.name, text }],
    idx: 1, nextAt: 0, lastSpeaker: null, generating: false, finished: true, outcome: null, privateGame,
  }) as any;
  (sim as any).nextAutoEvent = 1;
  (sim as any).finishChat(mkChat(true, "the cake was store-bought, promise you won't tell"), { outcomes: [], pairs: [] });
  await sleep(50);
  (sim as any).nextAutoEvent = 1;
  (sim as any).finishChat(mkChat(false, "what a lovely sunny day"), { outcomes: [], pairs: [] });
  await sleep(50);
  assert.equal(fed.length, 2, "both completed chats roll for an island event");
  assert.ok(!fed[0].includes("store-bought"), "private transcript never reaches generateEvent");
  assert.ok(fed[1].includes("sunny day"), "public transcripts still feed generateEvent");
  assert.ok(!fed[1].includes("store-bought"), "earlier private transcript stays out of later feeds");
});
