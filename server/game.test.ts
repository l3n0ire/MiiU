import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TUNING, applyAction, ensureSecrets, gameViewFor, knownSecrets, maybeStartFestival,
  removeFromGame, resolveDuePledges, resolveFestival,
  EXPOSE_WITNESS_COST, EXPOSE_LEAKER_COST, PLEDGE_BROKEN_COST, PLEDGE_KEPT_GAIN, SWITCH_CLOSE_COST,
  type ActionContext,
} from "./game.ts";
import { getRel, migrateWorld, seedWorld, type World } from "./world.ts";
import { USER_ID } from "./llm.ts";

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
