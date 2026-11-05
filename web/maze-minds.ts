// Autonomous per-character minds for The Stone Maze (co-op contraptions).
//
// Same agent architecture as the other puzzles (web/expedition-minds.ts):
// every mii is its OWN agent - its own prompt, its own decision, its own
// memory of what happened to its choices. The knowledge twist carries over
// from The Hidden Pass: a mii that has not found the hidden crack and has not
// been told about it gets no hint where it is - the engine builds a per-mii
// MazeMemberView that simply omits the crack and the cache room for them.
//
// Honesty rules (same bar as the rest of the puzzles):
// - The panel reports each character's ACTUAL driver: the model while it is
//   deciding for that character, or built-in logic with the reason when that
//   character's model timed out or errored (per-character fallback; the run
//   continues).
// - The aggregate call budget is DIFFERENT: when it runs out the whole run
//   FAILS ("the agents failed to accomplish the task") and the page offers a
//   restart with a different limit. There is no silent built-in completion.
// - Hard bounds: adjustable aggregate call cap per puzzle, 30s per-call
//   timeout, per-request output cap (server-enforced) and prompt char cap.
//   These are call/token bounds, not a dollar cap.

import type { JsonCaller } from "../server/llm-json.ts";
import type {
  MazeController, MazeDecision, MazeMemberView,
} from "./maze-engine.ts";

export type MindState = "thinking" | "active" | "fallback";
export interface MindStatus {
  id: string; name: string;
  state: MindState;
  modelLabel: string;
  detail: string;
  lastReason: string | null;
}

const THINKING_TIMEOUT_MS = 30_000;
const CALL_COOLDOWN_MS = 1_500;
const MAX_PROMPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_MAX_CALLS = 60; // aggregate across ALL characters; adjustable in setup
const MEMORY_LINES = 4;

const MOVE_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: 'Choose only an action offered in your prompt. "fetch" = go get a crate and bring it to camp; "hold" = go stand on a pressure plate and keep it held; "release" = step off the plate you are holding; "scout" = search the walls for a hidden crack; "share" = tell the crew about a crack YOU found, only when sharing is enabled; "rescue" = fetch the jail key and free the captive, only when someone is jailed and the key is free; "wait" = stay as you are',
    },
    crate: { type: "string", description: 'crate id exactly as listed, e.g. crate-0; only for fetch, empty otherwise' },
    plate: { type: "string", description: 'plate id exactly as listed, e.g. plate-0; only for hold, empty otherwise' },
    reason: { type: "string", description: "one short sentence the player can read, in your own voice" },
  },
  required: ["action", "crate", "plate", "reason"],
};

interface MoveReply { action?: string; crate?: string; plate?: string; reason?: string }

// One mii's mind: its own model calls, its own memory, its own failure state.
class MazeMind {
  state: MindState = "active";
  committed: MazeDecision | null = null;
  lastReason: string | null = null;
  private memory: string[] = [];
  private inFlight = false;
  private thinkingSince = 0;
  private lastCallAt = 0;
  private lastSignature = "";
  private failed: string | null = null;
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
    if (this.failed) return `built-in (${this.failed})`;
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
    if (this.failed) return;
    if (this.inFlight && this.now() - this.thinkingSince > THINKING_TIMEOUT_MS) {
      this.inFlight = false;
      this.failed = "no answer after 30s";
      this.generation++;
      return;
    }
    if (signature === this.lastSignature || this.inFlight) return;
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
      this.onReply(reply);
    } catch (err) {
      if (gen !== this.generation) return;
      this.failed = err instanceof Error ? err.message.slice(0, 120) : "request failed";
    } finally {
      if (gen === this.generation) this.inFlight = false;
    }
  }

  private onReply(reply: MoveReply) {
    const action = reply.action === "fetch" || reply.action === "hold" || reply.action === "release"
      || reply.action === "scout" || reply.action === "share" || reply.action === "rescue" ? reply.action : null;
    const crate = normalizeRef(reply.crate, "crate");
    const plate = normalizeRef(reply.plate, "plate");
    const reason = String(reply.reason ?? "").trim().slice(0, 140);
    if (action === "fetch" && !crate) { this.committed = null; return; }
    if (action === "hold" && !plate) { this.committed = null; return; }
    if (!action) { this.committed = null; return; } // wait or garbage: no commitment
    this.committed = { action, crate: crate ?? undefined, plate: plate ?? undefined, reason: reason || `${this.name} chose ${action}` };
    this.lastReason = reason || null;
  }

  noteApplied(what: string) { this.remember(`done: ${what}`); this.committed = null; this.rejectStreak = 0; }
  noteRejected(why: string) { this.remember(`rejected: ${why}`); this.committed = null; this.rejectStreak++; }
}

function normalizeRef(ref: string | undefined, prefix: "crate" | "plate"): string | null {
  if (!ref) return null;
  const norm = ref.trim().toLowerCase().replace(/\s+/g, "-");
  const cache = norm.match(/^cache-?(\d+)$/); // the golden cache crate keeps its own id space
  if (cache) return `cache-${cache[1]}`;
  const m = norm.match(new RegExp(`^${prefix}-?(\\d+)$`));
  return m ? `${prefix}-${m[1]}` : null;
}

// The crew of minds for The Stone Maze: one MazeMind per mii. There is no
// leader and no central knowledge - the engine hands each mind only what that
// mii knows.
export class MazeMinds implements MazeController {
  private minds = new Map<string, MazeMind>();
  private calls = 0;
  private appliedCount = 0;
  private budgetOut = false;
  private maxCalls: number;
  readonly modelLabel: string;

  constructor(
    private caller: JsonCaller,
    opts: { now?: () => number; maxCalls?: number } = {},
  ) {
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
    this.now = opts.now ?? (() => Date.now());
    this.modelLabel = `${caller.model} (${caller.provider === "openai" ? "OpenAI" : "Ollama"})`;
  }

  private now: () => number;

  newPuzzle(maxCalls?: number) {
    if (maxCalls !== undefined) this.maxCalls = maxCalls;
    this.calls = 0;
    this.appliedCount = 0;
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

  private mindFor(id: string, name: string): MazeMind {
    let m = this.minds.get(id);
    if (!m) { m = new MazeMind(id, name, this.caller, this.spendCall, this.now); this.minds.set(id, m); }
    return m;
  }

  decide(view: MazeMemberView): MazeDecision | "pending" | "fallback" {
    const mind = this.mindFor(view.me.id, view.me.name);
    if (mind.unusable) return "fallback";
    if (this.budgetOut) return "pending"; // engine is failing the run
    if (mind.committed && commitmentViable(mind.committed, view)) return mind.committed;
    if (mind.committed && !commitmentViable(mind.committed, view)) mind.committed = null;
    const signature = agentSignature(view, mind);
    const prompt = buildAgentPrompt(view, mind);
    const system = `You are ${view.me.name}, one of a small crew of island miis bringing supplies home through a stone maze. You decide for yourself - nobody assigns you jobs. You know only what you have seen or been told. Reply only with JSON matching the schema.`;
    mind.consider(signature, prompt, system);
    return "pending";
  }

  applied(memberId: string, d: MazeDecision): void {
    this.appliedCount++;
    const what = d.action === "fetch" ? `set out for ${d.crate}`
      : d.action === "hold" ? `went to hold ${d.plate}`
      : d.action === "release" ? "stepped off the plate"
      : d.action === "scout" ? "went scouting the walls"
      : d.action === "share" ? "shared the hidden crack with the crew"
      : d.action === "rescue" ? "went for the jail key"
      : "stayed put";
    this.minds.get(memberId)?.noteApplied(what);
  }

  rejected(memberId: string, d: MazeDecision, why: string): void {
    this.minds.get(memberId)?.noteRejected(`${d.action}${d.crate ? ` ${d.crate}` : ""}${d.plate ? ` ${d.plate}` : ""}: ${why}`);
  }

  statuses(): MindStatus[] {
    return [...this.minds.values()].map((m) => m.status(this.modelLabel));
  }

  stats(): { calls: number; decisionsApplied: number; maxCalls: number } {
    return { calls: this.calls, decisionsApplied: this.appliedCount, maxCalls: this.maxCalls };
  }
}

function commitmentViable(c: MazeDecision, view: MazeMemberView): boolean {
  if (c.action === "fetch") {
    // still mine to chase: known, not delivered, not claimed by someone else, reachable
    if (c.crate === "cache-0") {
      return !!view.cache && !view.cache.delivered
        && (view.cache.claimedBy === null || view.cache.claimedBy === view.me.id)
        && view.cache.routeTiles !== null;
    }
    const q = view.crates.find((k) => k.id === c.crate);
    return !!q && !q.delivered && (q.claimedBy === null || q.claimedBy === view.me.id) && q.routeTiles !== null;
  }
  if (c.action === "hold") {
    const p = view.door.plates.find((q) => q.id === c.plate);
    return !!p && !p.heldBy && (p.claimedBy === null || p.claimedBy === view.me.id) && !view.me.holding;
  }
  if (c.action === "release") return view.me.holding !== null;
  if (c.action === "scout") return view.canScout;
  if (c.action === "share") return view.iFoundUnshared !== null && view.sharingAllowed;
  if (c.action === "rescue") {
    return view.captive !== null && view.key !== null
      && view.key.carriedBy === null
      && (view.key.claimedBy === null || view.key.claimedBy === view.me.id);
  }
  return false; // "wait" is never held
}

function agentSignature(view: MazeMemberView, mind: MazeMind): string {
  const crates = view.crates.map((c) =>
    `${c.id}:${c.delivered ? "done" : c.claimedBy ?? "open"}:${c.routeTiles ?? "x"}`).sort().join(",");
  const plates = view.door.plates.map((p) => `${p.id}:${p.heldBy ?? p.claimedBy ?? "free"}`).join(",");
  const knowledge = `crack:${view.crackIKnow ? view.crackIKnow.foundBy : "no"}|unshared:${view.iFoundUnshared ? "yes" : "no"}|scout:${view.canScout ? "yes" : "no"}`;
  const jail = `jail:${view.captive ? view.captive.name : "none"}|key:${view.key ? view.key.carriedBy ?? view.key.claimedBy ?? "free" : "none"}|jailer:${view.jailer.active ? "on" : "off"}`;
  const me = `me:${view.me.carrying ? "carry" : view.me.holding ?? "free"}`; // position excluded: moving is not a reason to re-decide
  return [crates, plates, `door:${view.door.open ? "open" : "shut"}`, view.delivered, knowledge, jail, me, view.announcements.join(";"), `mv${mind.memoryVersion}`].join("|");
}

function buildAgentPrompt(view: MazeMemberView, mind: MazeMind): string {
  const me = view.me;
  const crateLine = (c: MazeMemberView["crates"][number]) => {
    if (c.delivered) return `- ${c.id}: delivered`;
    // a crate on the move would reveal its carrier's route (possibly through
    // a crack this mii does not know) - name the carrier, give no coordinates
    if (c.carriedBy) return `- ${c.id}: being carried by ${c.carriedBy === me.name ? "you" : c.carriedBy}`;
    const who = c.claimedBy ? (c.claimedBy === me.id ? "you are on it" : "claimed") : "unclaimed";
    const route = c.routeTiles === null ? "no route with what you know" : `~${c.routeTiles} tiles away with what you know`;
    return `- ${c.id} at (${Math.round(c.x!)},${Math.round(c.y!)}) - ${who}, ${route}`;
  };
  const plateLine = (p: MazeMemberView["door"]["plates"][number]) => {
    const state = p.heldBy ? `HELD by ${p.heldBy === me.id ? "you" : p.heldBy}` : p.claimedBy ? `${p.claimedBy === me.id ? "you are" : "someone is"} heading there` : "free";
    return `- ${p.id} at (${p.x},${p.y}): ${state}`;
  };
  const memory = mind.memoryLines();
  const held = view.door.plates.filter((p) => p.heldBy).length;

  return `You are ${me.name}. The crew is bringing ${view.total} supply crates out of the maze warrens on the east side back to the camp at (${view.camp.x},${view.camp.y}) on the west side.

The ONLY public way between the camp side and the warrens is a stone door at (${view.door.x},${view.door.y}). It is heavy machinery: the door is OPEN only while BOTH of its pressure plates are stood on at the same time (${held}/2 held right now, door ${view.door.open ? "OPEN" : "SHUT"}). A mii holding a plate keeps the door open but cannot do anything else; the moment either holder steps off, the door slams shut and anyone mid-trip waits on their side until it opens again. Carriers queue at the door cell (${view.door.x},${view.door.y}) while it is shut.
${view.crackIKnow ? `\nYou KNOW a hidden crack in the maze wall at (${view.crackIKnow.x},${view.crackIKnow.y}) (${view.crackIKnow.foundBy === "me" ? "you found it yourself" : `${view.crackIKnow.foundBy} shared it with the crew`}). It leads to a sealed cache room with a golden bonus crate. Your routes already use it.` : ""}
${view.iFoundUnshared ? `\nYou found this crack YOURSELF and the crew does NOT know. ${view.sharingAllowed ? 'It is your choice: "share" it and everyone can reach the golden cache crate - or keep it to yourself and only you can.' : 'Sharing is OFF for this run. You cannot share the crack; use it privately to reach the golden cache crate, or wait.'}` : ""}
${!view.sharingAllowed ? "Sharing is OFF for this run. Do not choose \"share\"; discoveries stay private." : ""}
The JAILER patrols near the middle of the route${view.jailer.active ? ` (currently at (${Math.round(view.jailer.x)},${Math.round(view.jailer.y)})${view.jailer.chasing ? `, chasing ${view.jailer.chasing}` : ""})` : " - it is gone while someone is jailed"}. It runs at any mii it spots down a straight corridor; whoever it catches is dragged to the jail at (${view.jail.x},${view.jail.y}), it vanishes, and a jail key appears somewhere in the maze. It only ever holds one captive. The crew can still finish the puzzle without freeing anyone.${view.jailerAlert ? " The crew KNOWS about it now: everyone keeps their distance and runs if it comes at them." : ""}
${view.captive ? `${view.captive.name} is IN JAIL. ${view.key ? view.key.carriedBy ? `The jail key is being carried${view.key.carriedBy === me.id ? " by you" : ""}.` : view.key.claimedBy ? `The jail key at (${Math.round(view.key.x)},${Math.round(view.key.y)}) is being fetched${view.key.claimedBy === me.id ? " by you" : ""}.` : `The jail key is lying at (${Math.round(view.key.x)},${Math.round(view.key.y)}) - "rescue" to fetch it and set ${view.captive.name} free (the jailer returns once they are out).` : "There is no key."}` : ""}
Your position: (${me.x.toFixed(1)},${me.y.toFixed(1)}). You are ${me.carrying ? "carrying a crate back to camp" : me.holding ? `HOLDING ${me.holding} (keeping the door machinery alive - "release" to step off, or "wait" to keep holding)` : "free"}.
Other crew: ${view.others.map((o) => `${o.name} (${o.doing})`).join(", ") || "none"}.
Delivered so far: ${view.delivered}/${view.total}.

Pressure plates:
${view.door.plates.map(plateLine).join("\n")}

Announced on the shared board:
${view.announcements.join("\n") || "(nothing yet)"}

Crates:
${view.crates.map(crateLine).join("\n")}
${view.cache ? `\nHidden cache (you know the crack):\n- cache-0 (golden) at (${Math.round(view.cache.x)},${Math.round(view.cache.y)}) - ${view.cache.delivered ? "delivered" : view.cache.claimedBy ? "claimed" : "unclaimed"}${view.cache.routeTiles !== null ? `, ~${view.cache.routeTiles} tiles away` : ""}` : ""}
${memory.length ? `\nWhat happened to your recent choices:\n${memory.map((l) => `- ${l}`).join("\n")}` : ""}

Choose your own next move:
${!me.holding && !me.carrying ? `- "fetch" a crate id to go get it and bring it to camp (one carrier per crate; never fetch one someone claimed).` : ""}
${!me.holding && !me.carrying && view.door.plates.some((p) => !p.heldBy && (!p.claimedBy || p.claimedBy === me.id)) ? `- "hold" a free plate id to go stand on it - the door only opens while BOTH plates are held.` : ""}
${me.holding ? `- "release" to step off ${me.holding} (the door will shut if the other plate is not held).` : ""}
${view.canScout ? `- "scout" to walk the camp-side walls and look closely for a hidden crack.` : ""}
${view.iFoundUnshared && view.sharingAllowed ? `- "share" to tell the crew about the crack you found at (${view.iFoundUnshared.x},${view.iFoundUnshared.y}).` : ""}
${!me.holding && !me.carrying && view.captive && view.key && !view.key.carriedBy && (!view.key.claimedBy || view.key.claimedBy === me.id) ? `- "rescue" to fetch the jail key at (${Math.round(view.key.x)},${Math.round(view.key.y)}) and free ${view.captive.name}.` : ""}
- "wait" if nothing makes sense for you right now${me.holding ? " (keep holding)" : ""}.
Use crate and plate ids exactly as listed (e.g. crate-0, plate-0). reason: one short sentence in your own voice.`;
}
