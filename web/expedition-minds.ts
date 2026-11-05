// Autonomous per-character minds for The Hidden Pass (knowledge sharing).
//
// Same agent architecture as the bridge puzzles (web/puzzle-minds.ts): every
// mii is its OWN agent - its own prompt, its own decision, its own memory of
// what happened to its choices. The knowledge twist:
//
// - Each mii's prompt contains ONLY what that mii knows (the engine builds a
//   per-mii MemberView). A mii that has not found the pass and has not been
//   told about it gets no hint where it is - not even indirectly: route
//   lengths are computed with its own knowledge.
// - Sharing is the mii's own choice. When it has an unshared personal
//   discovery, its options include "share" (tell the crew) and keeping it
//   private (only its own trips get shorter). Nothing shares automatically.
// - When another mii's route changes after a share, that is the engine
//   re-planning with the new knowledge - automatic, and the feed says so.
//
// Honesty rules (same bar as the rest of the puzzles):
// - The panel reports each character's ACTUAL driver: the model while it is
//   deciding for that character, or built-in logic with the reason while that
//   character's model is timing out or erroring. A failed call is retried
//   with backoff and the model takes over again when it answers - built-in
//   is cover, not a demotion (the run continues either way).
// - The aggregate call budget is DIFFERENT: when it runs out the whole run
//   FAILS ("the agents failed to accomplish the task") and the page offers a
//   restart with a different limit. There is no silent built-in completion.
// - Hard bounds: adjustable aggregate call cap per puzzle, adjustable
//   per-call timeout (default 30s, max 120s - llm-json aborts any single
//   fetch there), per-request output cap (server-enforced) and prompt char
//   cap.
//   These are call/token bounds, not a dollar cap.

import type { JsonCaller } from "../server/llm-json.ts";
import type {
  ExpeditionController, ExpeditionDecision, MemberView,
} from "./expedition-engine.ts";

export type MindState = "thinking" | "active" | "fallback";
export interface MindStatus {
  id: string; name: string;
  state: MindState;
  modelLabel: string;
  detail: string;
  lastReason: string | null;
}

const DEFAULT_THINKING_TIMEOUT_MS = 30_000;
const MAX_THINKING_TIMEOUT_MS = 120_000; // llm-json aborts any single fetch at 120s
const FAIL_RETRY_BASE_MS = 5_000; // first model retry after a failed call; doubles, capped
const FAIL_RETRY_CAP_MS = 60_000;
const CALL_COOLDOWN_MS = 1_500;
const MAX_PROMPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_MAX_CALLS = 40; // aggregate across ALL characters; adjustable in setup
const MEMORY_LINES = 4;

const MOVE_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: 'Choose only an action offered in your prompt. "fetch" = go get a crate and bring it to camp; "scout" = look closely for a hidden pass; "share" = tell the crew about a pass YOU found, only when sharing is enabled; "wait" = do nothing for now',
    },
    crate: { type: "string", description: "crate id exactly as listed, e.g. crate-0; only for fetch, empty otherwise" },
    reason: { type: "string", description: "one short sentence the player can read, in your own voice" },
  },
  required: ["action", "crate", "reason"],
};

interface MoveReply { action?: string; crate?: string; reason?: string }

// One mii's mind: its own model calls, its own memory, its own failure state.
class PassMind {
  state: MindState = "active";
  committed: ExpeditionDecision | null = null;
  lastReason: string | null = null;
  private memory: string[] = [];
  private inFlight = false;
  private thinkingSince = 0;
  private lastCallAt = 0;
  private lastSignature = "";
  private failed: string | null = null;
  private failStreak = 0;
  private retryAt = 0;
  private rejectStreak = 0;
  // Bumped on timeout and on newPuzzle: a response that arrives AFTER its
  // call's generation is stale and must not touch any state.
  private generation = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    private caller: JsonCaller,
    private spendCall: () => boolean, // false when the puzzle budget is exhausted
    private now: () => number,
    private timeoutMs: number = DEFAULT_THINKING_TIMEOUT_MS,
  ) {}

  freeze() { // the run failed: any in-flight reply is now stale
    this.generation++;
    this.inFlight = false;
    this.committed = null;
  }

  newPuzzle() {
    this.committed = null;
    this.memory = [];
    this.failed = null;
    this.failStreak = 0;
    this.retryAt = 0;
    this.lastSignature = "";
    this.lastReason = null;
    this.state = "active";
    this.generation++;
    this.inFlight = false;
  }

  memoryVersion = 0;

  remember(line: string) {
    this.memory.push(line);
    this.memoryVersion++;
    if (this.memory.length > MEMORY_LINES) this.memory.shift();
  }

  memoryLines(): string[] { return [...this.memory]; }

  detail(): string {
    if (this.failed) return `built-in (${this.failed}; the model keeps retrying)`;
    if (this.inFlight && !this.committed) return "thinking…";
    if (this.committed) return this.lastReason ?? "decided";
    return "watching";
  }

  status(modelLabel: string): MindStatus {
    return {
      id: this.id, name: this.name, modelLabel,
      state: this.failed ? "fallback" : this.inFlight && !this.committed ? "thinking" : "active",
      detail: this.detail(), lastReason: this.lastReason,
    };
  }

  get unusable(): boolean { return this.failed !== null; }

  consider(signature: string, prompt: string, system: string) {
    if (this.inFlight && this.now() - this.thinkingSince > this.timeoutMs) {
      this.inFlight = false;
      this.noteFailure(`no answer after ${Math.round(this.timeoutMs / 1000)}s`);
      this.generation++;
      return;
    }
    if (this.inFlight) return;
    if (this.failed && this.now() < this.retryAt) return; // backing off before the retry
    if (!this.failed && signature === this.lastSignature) return;
    const cooldown = CALL_COOLDOWN_MS * 2 ** Math.min(this.rejectStreak, 4);
    if (this.now() - this.lastCallAt < cooldown) return;
    if (!this.spendCall()) return; // budget out: the crew fails the run (engine checks budgetExhausted)
    this.lastSignature = signature;
    this.inFlight = true;
    this.thinkingSince = this.now();
    this.lastCallAt = this.now();
    void this.call(prompt.slice(0, MAX_PROMPT_CHARS), system, this.generation);
  }

  private async call(prompt: string, system: string, gen: number) {
    try {
      const reply = await this.caller.callJson<MoveReply>(prompt, MOVE_SCHEMA, {
        system, temperature: 0.4, maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      if (gen !== this.generation) return;
      this.failed = null; // the model answered again: it takes back over
      this.failStreak = 0;
      this.retryAt = 0;
      this.onReply(reply);
    } catch (err) {
      if (gen !== this.generation) return;
      this.noteFailure(err instanceof Error ? err.message.slice(0, 120) : "request failed");
    } finally {
      if (gen === this.generation) this.inFlight = false;
    }
  }

  // A slow or failed call is a lapse, not a demotion: built-in logic covers
  // the character (the panel says why) while the model retries with backoff.
  private noteFailure(reason: string) {
    this.failed = reason;
    this.failStreak++;
    this.retryAt = this.now() + Math.min(FAIL_RETRY_BASE_MS * 2 ** Math.min(this.failStreak - 1, 4), FAIL_RETRY_CAP_MS);
  }

  private onReply(reply: MoveReply) {
    const action = reply.action === "fetch" || reply.action === "scout" || reply.action === "share" ? reply.action : null;
    const crate = normalizeCrateRef(reply.crate);
    const reason = String(reply.reason ?? "").trim().slice(0, 140);
    if (action === "fetch" && !crate) { this.committed = null; return; }
    if (!action) { this.committed = null; return; } // wait or garbage: no commitment
    this.committed = { action, crate: crate ?? undefined, reason: reason || `${this.name} chose ${action}` };
    this.lastReason = reason || null;
  }

  noteApplied(what: string) { this.remember(`done: ${what}`); this.committed = null; this.rejectStreak = 0; }
  noteRejected(why: string) { this.remember(`rejected: ${why}`); this.committed = null; this.rejectStreak++; }
}

function normalizeCrateRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = ref.trim().toLowerCase().replace(/\s+/g, "-").match(/^crate-?(\d+)$/);
  return m ? `crate-${m[1]}` : null;
}

// The crew of minds for The Hidden Pass: one PassMind per mii. There is no
// leader and no central knowledge - the engine hands each mind only what that
// mii knows.
export class PassMinds implements ExpeditionController {
  private minds = new Map<string, PassMind>();
  private calls = 0;
  private appliedCount = 0;
  private budgetOut = false;
  private maxCalls: number;
  readonly modelLabel: string;

  constructor(
    private caller: JsonCaller,
    opts: { now?: () => number; maxCalls?: number; thinkingTimeoutMs?: number } = {},
  ) {
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
    this.thinkingTimeoutMs = Math.min(Math.max(opts.thinkingTimeoutMs ?? DEFAULT_THINKING_TIMEOUT_MS, 10_000), MAX_THINKING_TIMEOUT_MS);
    this.now = opts.now ?? (() => Date.now());
    this.modelLabel = `${caller.model} (${caller.provider === "openai" ? "OpenAI" : "Ollama"})`;
  }

  private readonly thinkingTimeoutMs: number;

  private now: () => number;

  newPuzzle(maxCalls?: number) {
    if (maxCalls !== undefined) this.maxCalls = maxCalls;
    this.calls = 0;
    this.budgetOut = false;
    for (const m of this.minds.values()) m.newPuzzle();
  }

  private spendCall = () => {
    if (++this.calls <= this.maxCalls) return true;
    this.calls--;
    this.budgetOut = true; // the RUN fails - no silent built-in completion
    return false;
  };

  budgetExhausted(): boolean { return this.budgetOut; }

  runFailed(): void { for (const m of this.minds.values()) m.freeze(); }

  private mindFor(id: string, name: string): PassMind {
    let m = this.minds.get(id);
    if (!m) { m = new PassMind(id, name, this.caller, this.spendCall, this.now, this.thinkingTimeoutMs); this.minds.set(id, m); }
    return m;
  }

  decide(view: MemberView): ExpeditionDecision | "pending" | "fallback" {
    const mind = this.mindFor(view.me.id, view.me.name);
    if (this.budgetOut) return "pending"; // engine is failing the run
    if (mind.committed && commitmentViable(mind.committed, view)) return mind.committed;
    if (mind.committed && !commitmentViable(mind.committed, view)) mind.committed = null;
    const signature = agentSignature(view, mind);
    const prompt = buildAgentPrompt(view, mind);
    const system = `You are ${view.me.name}, one of a small crew of island miis bringing supplies home across a ridge. You decide for yourself - nobody assigns you jobs. You know only what you have seen or been told. Reply only with JSON matching the schema.`;
    mind.consider(signature, prompt, system); // retries a failed mind once its backoff expires
    if (mind.unusable) return "fallback"; // built-in covers this mii until its model answers again
    return "pending";
  }

  applied(memberId: string, d: ExpeditionDecision): void {
    this.appliedCount++;
    const what = d.action === "fetch" ? `set out for ${d.crate}`
      : d.action === "scout" ? "went scouting the ridge"
      : d.action === "share" ? "shared the pass with the crew"
      : "waited";
    this.minds.get(memberId)?.noteApplied(what);
  }

  rejected(memberId: string, d: ExpeditionDecision, why: string): void {
    this.minds.get(memberId)?.noteRejected(`${d.action}${d.crate ? ` ${d.crate}` : ""}: ${why}`);
  }

  statuses(): MindStatus[] {
    return [...this.minds.values()].map((m) => m.status(this.modelLabel));
  }

  stats(): { calls: number; decisionsApplied: number; maxCalls: number } {
    return { calls: this.calls, decisionsApplied: this.appliedCount, maxCalls: this.maxCalls };
  }
}

function commitmentViable(c: ExpeditionDecision, view: MemberView): boolean {
  if (c.action === "fetch") {
    const crate = view.crates.find((q) => q.id === c.crate);
    // still mine to chase: not delivered, not claimed by someone else, reachable
    return !!crate && !crate.delivered && (crate.claimedBy === null || crate.claimedBy === view.me.id) && crate.routeTiles !== null;
  }
  if (c.action === "scout") return view.canScout;
  if (c.action === "share") return view.iFoundUnshared !== null && view.sharingAllowed;
  return false; // "wait" is never held
}

function agentSignature(view: MemberView, mind: PassMind): string {
  const crates = view.crates.map((c) =>
    `${c.id}:${c.delivered ? "done" : c.claimedBy ?? "open"}:${c.routeTiles ?? "x"}`).sort().join(",");
  const knowledge = `pass:${view.passIKnow ? view.passIKnow.foundBy : "no"}|unshared:${view.iFoundUnshared ? "yes" : "no"}|scout:${view.canScout ? "yes" : "no"}`;
  return [crates, view.delivered, knowledge, view.announcements.join(";"), `mv${mind.memoryVersion}`].join("|");
}

function buildAgentPrompt(view: MemberView, mind: PassMind): string {
  const me = view.me;
  const crateLine = (c: MemberView["crates"][number]) => {
    if (c.delivered) return `- ${c.id}: delivered`;
    // a crate on the move would reveal its carrier's route (possibly through
    // a pass this mii does not know) - name the carrier, give no coordinates
    if (c.carriedBy) return `- ${c.id}: being carried by ${c.carriedBy === me.name ? "you" : c.carriedBy}`;
    const who = c.claimedBy ? (c.claimedBy === me.id ? "you are on it" : "claimed") : "unclaimed";
    const route = c.routeTiles === null ? "no route with what you know" : `~${c.routeTiles} tiles away with what you know`;
    return `- ${c.id} at (${Math.round(c.x!)},${Math.round(c.y!)}) - ${who}, ${route}`;
  };
  const memory = mind.memoryLines();

  return `You are ${me.name}. The crew is bringing ${view.total} supply crates from the grove on the east side of the island back to the camp at (${view.camp.x},${view.camp.y}) on the west side. A rock ridge splits the island in between.

The known way around the ridge is the detour gap at (${view.detour.x},${view.detour.y}) - everyone knows it, and it is a long walk. A narrow hidden pass may cut straight through the ridge somewhere - but nobody knows where, or whether it exists, until someone walks up to the ridge and scouts it closely. Rushing past on an errand finds nothing; only scouting does.
${view.passIKnow ? `\nYou KNOW a hidden pass through the ridge at (${view.passIKnow.x},${view.passIKnow.y}) (${view.passIKnow.foundBy === "me" ? "you found it yourself" : `${view.passIKnow.foundBy} shared it with the crew`}). Your routes already use it.` : ""}
${view.iFoundUnshared ? `\nYou found this pass YOURSELF and the crew does NOT know. ${view.sharingAllowed ? 'It is your choice: "share" it and everyone\'s trips can get shorter - or keep it to yourself and only your own trips get shorter.' : 'Sharing is OFF for this run. You cannot share the pass; use it privately to fetch supplies, or wait.'}` : ""}
${!view.sharingAllowed ? 'Sharing is OFF for this run. Do not choose "share"; discoveries stay private.' : ""}
Your position: (${me.x.toFixed(1)},${me.y.toFixed(1)}). You are ${me.carrying ? "carrying a crate back to camp" : "free"}.
Other crew: ${view.others.map((o) => `${o.name} (${o.free ? "free" : "busy"})`).join(", ") || "none"}.
Delivered so far: ${view.delivered}/${view.total}.

Announced on the shared board:
${view.announcements.join("\n") || "(nothing yet)"}

Crates:
${view.crates.map(crateLine).join("\n")}
${memory.length ? `\nWhat happened to your recent choices:\n${memory.map((l) => `- ${l}`).join("\n")}` : ""}

Choose your own next move:
- "fetch" a crate id to go get it and bring it to camp (one carrier per crate; never fetch one someone claimed).
${view.canScout ? `- "scout" to walk up to the ridge and look closely for a hidden pass.` : ""}
${view.iFoundUnshared && view.sharingAllowed ? `- "share" to tell the crew about the pass you found at (${view.iFoundUnshared.x},${view.iFoundUnshared.y}).` : ""}
- "wait" if nothing makes sense for you right now.
Use crate ids exactly as listed (e.g. crate-0). reason: one short sentence in your own voice.`;
}
