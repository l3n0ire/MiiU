// The island's game layer: festival-host races, secrets, and promises.
// The language model writes dialogue and may attach ONE action per line; this module
// owns what is legal, what it costs, and who knows what. The chat summarizer still
// judges social bonding (affinity deltas compose with these priced consequences);
// it never sets game state.
//
// Timing: everything runs on world.game.clockMs, which the sim advances only while
// running unpaused. Closed tabs and paused time never count toward deadlines.

import { USER_ID } from "./llm.ts";
import {
  getRel, recordRelChange,
  type Character, type Pledge, type Secret, type World,
} from "./world.ts";

export interface GameTuning {
  campaignMs: number; // sim-active ms a race stays open
  cooldownMs: number; // sim-active ms between resolution and the next race
  tellWindowMs: number; // sim-active ms a tell-promise gets
}
export const DEFAULT_TUNING: GameTuning = {
  campaignMs: 15 * 60_000,
  cooldownMs: 20 * 60_000,
  tellWindowMs: 10 * 60_000,
};

// Fixed, visible prices for game consequences.
export const EXPOSE_WITNESS_COST = -10; // the exposed resident loses this with every other resident
export const EXPOSE_LEAKER_COST = -20; // and this with whoever leaked
export const SWITCH_CLOSE_COST = -10; // switching festival backing away from a close bond
export const PLEDGE_KEPT_GAIN = 8;
export const PLEDGE_BROKEN_COST = -12;

const CLOSE_LABELS = new Set(["friend", "best friend", "crush", "family"]);
const CLOSE_AFFINITY = 40;
const MAX_SECRETS = 80;

let nextId = 1;
const gid = (p: string) => `${p}${Date.now().toString(36)}-${(nextId++).toString(36)}`;

const byId = (world: World, id: string) => world.characters.find((c) => c.id === id);
const nameOf = (world: World, id: string) => (id === USER_ID ? "you" : byId(world, id)?.name ?? "someone");

// ---------- secrets ----------

const SEED_SECRETS: Record<string, string> = {
  Pip: "The cake everyone praised at the last potluck was store-bought, not homemade.",
  Marlo: "Writes mystery novels under a pen name and is mortified anyone might find out.",
  Juniper: "Once painted over a sold commission because the moon 'disapproved' - and never told the buyer.",
  Gus: "Lost the island frisbee championship but tells everyone he won it.",
};
const GENERIC_SECRETS = [
  "Arrived on the island under a made-up name.",
  "Has never learned to swim and dodges every beach invitation.",
  "Once won a pie-eating contest and vowed never to speak of it.",
  "Keeps a jar of sand from a home island under the bed.",
  "Talks to houseplants and is convinced one answers back.",
];

function addSecret(world: World, subject: string, text: string): Secret {
  const s: Secret = { id: gid("sec"), subject, text, knownBy: [subject], toldBy: { [subject]: null }, exposed: false };
  world.game.secrets.push(s);
  if (world.game.secrets.length > MAX_SECRETS) world.game.secrets.shift();
  return s;
}

// Every resident starts with one secret only they know (seed residents get a
// personality-matched one, newcomers a generic one). Idempotent per character.
export function ensureSecrets(world: World): void {
  for (const c of world.characters) {
    if (world.game.secrets.some((s) => s.subject === c.id)) continue;
    addSecret(world, c.id, SEED_SECRETS[c.name] ?? GENERIC_SECRETS[Math.floor(Math.random() * GENERIC_SECRETS.length)]);
  }
}

export function knownSecrets(world: World, id: string): Secret[] {
  return world.game.secrets.filter((s) => s.knownBy.includes(id));
}

// Who the subject would learn about on exposure: the tell-chain, one hop per name.
function chainFor(world: World, s: Secret): string[] {
  const chain: string[] = [];
  for (const k of s.knownBy) {
    if (k === s.subject) continue;
    const from = s.toldBy[k];
    if (from && from !== s.subject) chain.push(`${nameOf(world, from)} told ${nameOf(world, k)}`);
    else chain.push(`${nameOf(world, k)} found out`);
  }
  return chain;
}

// ---------- festival races ----------

// Start a race if none is active and the cooldown has passed. Needs at least
// two candidates plus one voter, so islands smaller than 3 sit this out.
export function maybeStartFestival(world: World, t: GameTuning): string | null {
  const g = world.game;
  const f = g.festival;
  if (f && f.status === "campaigning") return null;
  if (f && f.nextAt !== null && g.clockMs < f.nextAt) return null;
  if (world.characters.length < 3) return null;
  const pool = [...world.characters];
  const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const b = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  g.festival = {
    status: "campaigning",
    candidates: [a.id, b.id],
    endorsements: {},
    deadline: g.clockMs + t.campaignMs,
    winner: null,
    nextAt: null,
  };
  return `🏁 The festival-host race begins: ${a.name} vs ${b.name}! Back your favorite before the festival.`;
}

// Count endorsements at the deadline: a strict majority wins, a tie or an
// endorsement-less race flops. Returns the island-news headline.
export function resolveFestival(world: World, t: GameTuning): string | null {
  const g = world.game;
  const f = g.festival;
  if (!f || f.status !== "campaigning" || g.clockMs < f.deadline) return null;
  const tally = new Map<string, number>(f.candidates.map((c) => [c, 0]));
  for (const cand of Object.values(f.endorsements)) {
    if (tally.has(cand)) tally.set(cand, (tally.get(cand) ?? 0) + 1);
  }
  const [top, second] = [...tally.entries()].sort((x, y) => y[1] - x[1]);
  let text: string;
  if (top && top[1] > 0 && top[1] > (second?.[1] ?? 0)) {
    f.status = "decided";
    f.winner = top[0];
    const w = byId(world, top[0]);
    if (w) w.mood = "excited";
    text = `🎪 ${nameOf(world, top[0])} is the Festival Host with ${top[1]} endorsement${top[1] === 1 ? "" : "s"}!`;
  } else {
    f.status = "flopped";
    f.winner = null;
    for (const cid of f.candidates) {
      const c = byId(world, cid);
      if (c) c.mood = "sad";
    }
    text = top && top[1] > 0
      ? `🌧 The festival flopped - the host race ended in a tie.`
      : `🌧 The festival flopped - nobody backed anyone.`;
  }
  f.nextAt = g.clockMs + t.cooldownMs;
  return text;
}

// A resident leaving the island mid-race: drop their votes and candidacy.
export function removeFromGame(world: World, id: string): void {
  const g = world.game;
  const f = g.festival;
  if (f) {
    f.candidates = f.candidates.filter((c) => c !== id);
    delete f.endorsements[id];
    for (const [voter, cand] of Object.entries(f.endorsements)) if (cand === id) delete f.endorsements[voter];
    if (f.status === "campaigning" && f.candidates.length === 0) {
      f.status = "flopped";
      f.nextAt = g.clockMs;
    }
  }
  g.secrets = g.secrets.filter((s) => s.subject !== id);
  for (const s of g.secrets) {
    s.knownBy = s.knownBy.filter((k) => k !== id);
    delete s.toldBy[id];
  }
  g.pledges = g.pledges.filter((p) => p.promiser !== id && p.promisee !== id);
}

// ---------- shared consequence helpers ----------

function shiftAffinity(world: World, aId: string, bId: string, delta: number, cause: string): void {
  const rel = getRel(world, aId, bId);
  const before = rel.timeline.length ? rel.label : null;
  rel.affinity = Math.max(-100, Math.min(100, rel.affinity + delta));
  recordRelChange(rel, delta, cause, before);
}

function remember(world: World, id: string, text: string): void {
  const c = byId(world, id);
  if (!c) return; // the player has no memory list
  c.memories.push(text);
  if (c.memories.length > 10) c.memories.shift();
}

function relHistory(world: World, aId: string, bId: string, text: string): void {
  const rel = getRel(world, aId, bId);
  rel.history.push(text);
  if (rel.history.length > 10) rel.history.shift();
}

// ---------- promises (pledges) ----------

// One pledge per (promiser, promisee, secret, kind), ever - resolved pledges block
// re-promising the same triple, so kept-promise trust cannot be farmed.
function pledgeExists(world: World, promiser: string, promisee: string, secret: string, kind: Pledge["kind"]): boolean {
  return world.game.pledges.some(
    (p) => p.promiser === promiser && p.promisee === promisee && p.secret === secret && p.kind === kind,
  );
}

function makePledge(world: World, promiser: string, promisee: string, kind: Pledge["kind"], secret: Secret, deadline: number): Pledge {
  const p: Pledge = { id: gid("plg"), promiser, promisee, kind, secret: secret.id, deadline, status: "active" };
  world.game.pledges.push(p);
  const what = kind === "keep_secret" ? `keep the secret about ${nameOf(world, secret.subject)} until the festival` : `tell them the secret about ${nameOf(world, secret.subject)}`;
  remember(world, promiser, `(promise) You promised ${nameOf(world, promisee)} to ${what}.`);
  remember(world, promisee, `(promise) ${nameOf(world, promiser)} promised to ${what}.`);
  return p;
}

function settlePledge(world: World, p: Pledge, kept: boolean, why: string): void {
  if (p.status !== "active") return;
  p.status = kept ? "kept" : "broken";
  const delta = kept ? PLEDGE_KEPT_GAIN : PLEDGE_BROKEN_COST;
  const mark = `${nameOf(world, p.promiser)} ${kept ? "kept" : "broke"} a promise to ${nameOf(world, p.promisee)} (${why})`;
  shiftAffinity(world, p.promiser, p.promisee, delta, mark);
  relHistory(world, p.promiser, p.promisee, mark);
  remember(world, p.promiser, `(promise ${kept ? "kept" : "broken"}) ${mark}.`);
  remember(world, p.promisee, `(promise ${kept ? "kept" : "broken"}) ${mark}.`);
}

// A keep-secret pledge breaks the moment the promiser shares or exposes that secret.
function breakKeepPledges(world: World, promiser: string, secretId: string): void {
  for (const p of world.game.pledges) {
    if (p.status === "active" && p.kind === "keep_secret" && p.promiser === promiser && p.secret === secretId) {
      settlePledge(world, p, false, "the secret got out");
    }
  }
}

// Deadline sweep: keep-secret pledges that survived are kept; unfulfilled
// tell-secret pledges are broken.
export function resolveDuePledges(world: World): string[] {
  const settled: string[] = [];
  for (const p of world.game.pledges) {
    if (p.status !== "active" || world.game.clockMs < p.deadline) continue;
    const kept = p.kind === "keep_secret";
    settlePledge(world, p, kept, kept ? "kept until the festival" : "never delivered");
    settled.push(`${nameOf(world, p.promiser)} ${kept ? "kept" : "broke"} a promise to ${nameOf(world, p.promisee)}`);
  }
  return settled;
}

// ---------- dialogue actions ----------

export const ACTION_KINDS = ["none", "endorse", "switch", "hint", "tell", "expose", "promise_keep", "promise_tell"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

// Raw model output: candidate/to are resident NAMES, secret is the 1-based index
// into the speaker's known-secret list as shown in their prompt.
export interface RawAction {
  kind?: unknown;
  candidate?: unknown;
  secret?: unknown;
  to?: unknown;
}

export interface ActionContext {
  present: { id: string; name: string }[]; // everyone still in the conversation (may include the player)
  tuning: GameTuning;
}

export interface AppliedAction {
  kind: ActionKind;
  event?: string; // public island news (endorse/switch/expose only)
  note?: string; // private outcome, for logs/tests
}

const nameEq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function findPresent(ctx: ActionContext, name: string) {
  return ctx.present.find((p) => nameEq(p.name, name));
}

// Validate a raw action against the ledger and apply it. Anything illegal is
// dropped to "none" - the spoken line still stands, it just does nothing.
export function applyAction(world: World, speakerId: string, raw: RawAction | undefined, ctx: ActionContext): AppliedAction {
  const g = world.game;
  const kind = (ACTION_KINDS as readonly unknown[]).includes(raw?.kind) ? (raw!.kind as ActionKind) : "none";
  if (kind === "none") return { kind: "none" };
  const speaker = byId(world, speakerId);
  if (!speaker) return { kind: "none" };
  const known = knownSecrets(world, speakerId);
  const idx = typeof raw?.secret === "number" ? Math.round(raw.secret) : 0;
  const secret = idx >= 1 && idx <= known.length ? known[idx - 1] : null;
  const f = g.festival;
  const campaigning = f?.status === "campaigning" ? f : null;
  const isCandidate = campaigning?.candidates.includes(speakerId) ?? false;

  if (kind === "endorse" || kind === "switch") {
    const candName = typeof raw?.candidate === "string" ? raw.candidate : "";
    const target = campaigning?.candidates.find((id) => nameEq(nameOf(world, id), candName));
    if (!campaigning || isCandidate || !target) return { kind: "none" };
    const current = campaigning.endorsements[speakerId];
    if (current === target) return { kind: "none" }; // already backing them: no repeat events
    campaigning.endorsements[speakerId] = target;
    if (!current) {
      return { kind, event: `🗳 ${speaker.name} endorsed ${nameOf(world, target)} for Festival Host!` };
    }
    // Switching only stings when it abandons a close bond; otherwise it is just politics.
    const rel = getRel(world, speakerId, current);
    const close = CLOSE_LABELS.has(rel.label) || rel.affinity >= CLOSE_AFFINITY;
    let note: string | undefined;
    if (close) {
      shiftAffinity(world, speakerId, current, SWITCH_CLOSE_COST, `${speaker.name} switched festival backing away from ${nameOf(world, current)}`);
      note = `switch cost ${SWITCH_CLOSE_COST} with ${nameOf(world, current)} (close bond)`;
    }
    return { kind, event: `🗳 ${speaker.name} switched their backing from ${nameOf(world, current)} to ${nameOf(world, target)}!`, note };
  }

  if (!secret) return { kind: "none" }; // every remaining kind needs a known secret

  if (kind === "hint") return { kind }; // pure flavor: the line itself is the tease

  if (kind === "tell") {
    // Private by construction: only legal one-on-one, so the content never lands in a group transcript.
    const toName = typeof raw?.to === "string" ? raw.to : "";
    const target = findPresent(ctx, toName);
    if (!target || ctx.present.length !== 2 || target.id === speakerId) return { kind: "none" };
    if (secret.knownBy.includes(target.id)) return { kind: "none" }; // they already know
    secret.knownBy.push(target.id);
    secret.toldBy[target.id] = speakerId;
    breakKeepPledges(world, speakerId, secret.id);
    for (const p of g.pledges) {
      if (p.status === "active" && p.kind === "tell_secret" && p.promiser === speakerId && p.secret === secret.id && p.promisee === target.id) {
        settlePledge(world, p, true, "delivered as promised");
      }
    }
    remember(world, speakerId, `(secret) You told ${target.name} the secret about ${nameOf(world, secret.subject)}.`);
    remember(world, target.id, `(secret) ${speaker.name} told you privately: "${secret.text}" (about ${nameOf(world, secret.subject)}).`);
    return { kind, note: `told ${target.name} secret ${secret.id}` };
  }
  return applyRest(world, speaker, kind, secret, raw ?? {}, ctx);
}

function applyRest(world: World, speaker: Character, kind: ActionKind, secret: Secret, raw: RawAction, ctx: ActionContext): AppliedAction {
  const g = world.game;
  if (kind === "expose") {
    if (secret.exposed) return { kind: "none" }; // single-use
    secret.exposed = true;
    breakKeepPledges(world, speaker.id, secret.id);
    const subject = byId(world, secret.subject);
    const isSelf = secret.subject === speaker.id;
    if (subject && !isSelf) {
      // Priced consequences: the exposed resident with every witness, harsher with the leaker.
      for (const c of world.characters) {
        if (c.id === secret.subject) continue;
        const cost = c.id === speaker.id ? EXPOSE_LEAKER_COST : EXPOSE_WITNESS_COST;
        shiftAffinity(world, secret.subject, c.id, cost, `${speaker.name} exposed ${subject.name}'s secret`);
      }
      subject.mood = "angry";
      const chain = chainFor(world, secret);
      // Leak discovery: the subject privately learns how it spread.
      remember(world, secret.subject, `(exposed) ${speaker.name} exposed your secret${chain.length ? `; it spread via: ${chain.join(", ")}` : ""}.`);
    }
    remember(world, speaker.id, `(exposed) You exposed the secret about ${nameOf(world, secret.subject)}.`);
    const text = `📣 Secret exposed: ${secret.text} (about ${nameOf(world, secret.subject)})`;
    return { kind, event: text, note: isSelf ? "self-exposure: no affinity costs" : `costs applied (${EXPOSE_WITNESS_COST} witnesses, ${EXPOSE_LEAKER_COST} leaker)` };
  }

  // promise_keep / promise_tell: the promisee is the named conversation partner.
  const toName = typeof raw?.to === "string" ? raw.to : "";
  const target = findPresent(ctx, toName);
  if (!target || target.id === speaker.id) return { kind: "none" };
  const campaigning = g.festival?.status === "campaigning" ? g.festival : null;

  if (kind === "promise_keep") {
    if (secret.exposed || !campaigning) return { kind: "none" }; // needs the festival deadline as anchor
    if (pledgeExists(world, speaker.id, target.id, secret.id, "keep_secret")) return { kind: "none" };
    makePledge(world, speaker.id, target.id, "keep_secret", secret, campaigning.deadline);
    return { kind, note: `pledged to keep secret ${secret.id} for ${target.name} until the festival` };
  }

  // promise_tell: vow to tell THIS person this secret soon.
  if (secret.knownBy.includes(target.id)) return { kind: "none" };
  if (pledgeExists(world, speaker.id, target.id, secret.id, "tell_secret")) return { kind: "none" };
  makePledge(world, speaker.id, target.id, "tell_secret", secret, g.clockMs + ctx.tuning.tellWindowMs);
  return { kind, note: `pledged to tell ${target.name} secret ${secret.id}` };
}

// ---------- prompt view ----------

// Everything one speaker may know about the game, and nothing more. Secrets they
// do not know never appear here, and neither does anyone else's promise ledger.
export function gameViewFor(world: World, speakerId: string, tuning: GameTuning): string {
  const g = world.game;
  const out: string[] = [];
  const f = g.festival;
  if (f?.status === "campaigning") {
    const mins = Math.max(1, Math.round((f.deadline - g.clockMs) / 60000));
    const tally = f.candidates.map((c) => `${nameOf(world, c)} ${Object.values(f.endorsements).filter((v) => v === c).length}`).join(", ");
    const mine = f.endorsements[speakerId];
    const role = f.candidates.includes(speakerId)
      ? "You are a candidate - campaign for backing!"
      : mine
        ? `You back ${nameOf(world, mine)}.`
        : "You have not backed anyone yet.";
    out.push(`Festival-host race: ${f.candidates.map((c) => nameOf(world, c)).join(" vs ")} (current backing: ${tally}); voting closes in ~${mins} min of island time. ${role}`);
  } else if (f) {
    out.push(f.status === "decided" ? `${nameOf(world, f.winner!)} is the Festival Host.` : "The last festival flopped. A new race is coming.");
  }
  const known = knownSecrets(world, speakerId);
  if (known.length) {
    out.push("Secrets you know (nobody else knows what you know):");
    known.forEach((s, i) => out.push(`  ${i + 1}) about ${nameOf(world, s.subject)}${s.exposed ? " [already public]" : ""}: "${s.text}"`));
  }
  const mine = g.pledges.filter((p) => p.status === "active" && p.promiser === speakerId);
  for (const p of mine) {
    const s = g.secrets.find((x) => x.id === p.secret);
    if (s) out.push(`Promise you made: ${p.kind === "keep_secret" ? "keep" : "tell"} the secret about ${nameOf(world, s.subject)}${p.kind === "tell_secret" ? ` to ${nameOf(world, p.promisee)}` : ""}.`);
  }
  if (!out.length) return "";
  return `Island game - you may attach ONE action to your line (only if it is legal right now; anything illegal is ignored):
${out.join("\n")}
action choices: {"kind":"none"} (just talk) | {"kind":"endorse","candidate":"name"} or {"kind":"switch","candidate":"name"} to publicly back a festival candidate (never if YOU are a candidate) | {"kind":"hint","secret":N} tease a secret you know without revealing it | {"kind":"tell","secret":N,"to":"name"} privately reveal it (one-on-one ONLY) | {"kind":"expose","secret":N} make it island news (hurts them, and you) | {"kind":"promise_keep","secret":N,"to":"name"} vow to keep it until the festival | {"kind":"promise_tell","secret":N,"to":"name"} vow to tell them within 10 minutes.
Secrets N refer to your numbered list above. Never reveal or hint at secrets not on your list.`;
      }
