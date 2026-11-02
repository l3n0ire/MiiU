// Autonomous per-character minds for the bridge puzzle.
//
// Unlike the old central planner (puzzle-brain.ts, one model assigning the
// whole crew), every mii here is its OWN agent: its own prompt, its own
// decision, its own memory of what happened to its choices. There is no
// boss. Coordination is something the characters DO, not something the code
// decides for them:
//
// - Every committed intention is announced on a shared board that every
//   other character sees in its next prompt ("Pip is fetching block-0",
//   "Marlo wants a partner for beam-1").
// - Blocks are solo: a character claims one, the engine validates it.
// - Beams need TWO independent decisions that meet: one character claims
//   the beam and asks for a partner; another character, seeing the request
//   on the board, independently accepts it. Only when both choices exist
//   does this module emit the pair to the engine - the engine never invents
//   consent, and neither do we.
// - Conflicts are told back to the loser ("block-0 was taken by Pip"), who
//   then re-decides. Decisions only happen when a character's situation
//   changes - never per frame - because every call spends the visitor's key.
//
// Honesty rules (same bar as the rest of the puzzle):
// - The panel reports each character's ACTUAL driver: the model while it is
//   deciding for that character, or built-in logic with the reason when that
//   character's model failed/timed out/ran out of calls.
// - A character whose model fails falls back ALONE (PartialReply builtinFor);
//   the others keep their model drivers.
// - Hard bounds: aggregate call cap per puzzle, 30s per-call timeout,
//   per-request output cap (server-enforced) and prompt char cap. These are
//   call/token bounds, not a dollar cap.

import type { JsonCaller } from "../server/llm-json.ts";
import type {
  AssignmentDecision, ControllerReply, CrewController, DecisionView,
} from "./puzzle-engine.ts";

export type MindState = "thinking" | "active" | "fallback";
export interface MindStatus {
  id: string; name: string;
  state: MindState;
  modelLabel: string;
  detail: string;          // honest per-character driver line for the UI
  lastReason: string | null;
}

const THINKING_TIMEOUT_MS = 30_000;
const CALL_COOLDOWN_MS = 1_500;
const MAX_PROMPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2000;
// Aggregate across ALL characters: call-count bound, not a dollar bound.
const MAX_CALLS_PER_PUZZLE = 40;
// A beam lead waiting this long for a partner reconsiders on its own.
const PARTNER_WAIT_MS = 45_000;
const MEMORY_LINES = 4;

const MOVE_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: '"claim" = take a piece yourself; "help" = accept someone\'s open beam help request; "decline" = openly refuse an open beam ask (the asker is told); "wait" = do nothing for now',
    },
    piece: { type: "string", description: "piece id exactly as listed, e.g. block-0; empty when waiting" },
    reason: { type: "string", description: "one short sentence the player can read, in your own voice" },
  },
  required: ["action", "piece", "reason"],
};

interface MoveReply { action?: string; piece?: string; reason?: string }

interface CommittedMove {
  action: "claim" | "help";
  piece: string;
  reason: string;
  at: number;
}

// What a mind chose about an open ask it does not want: a visible, explicit
// refusal the asker is told about - never manufactured consent, never silent
// ambiguity the asker has to infer.
interface MindEvents {
  onDecline: (mindId: string, piece: string, reason: string) => void;
}

// One mii's mind: its own model calls, its own memory, its own failure state.
class CharacterMind {
  state: MindState = "active";
  committed: CommittedMove | null = null;
  lastReason: string | null = null;
  private memory: string[] = [];
  private inFlight = false;
  private thinkingSince = 0;
  private lastCallAt = 0;
  private lastSignature = "";
  private failed: string | null = null;
  private rejectStreak = 0;
  // Bumped on timeout and on newPuzzle: a response that arrives AFTER its
  // call's generation is stale and must not touch any state - otherwise a
  // late answer could commit a move on a mind the panel already shows as
  // fallen back (or on a fresh puzzle), making source and display disagree.
  private generation = 0;

  private declinedNote: string | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    private caller: JsonCaller,
    private spendCall: () => boolean, // false when the puzzle budget is exhausted
    private now: () => number,
    private events: MindEvents,
  ) {}

  clearDeclinedNote(piece: string) {
    if (this.declinedNote === `declined the ask for ${piece}`) this.declinedNote = null;
  }

  newPuzzle() {
    this.committed = null;
    this.declinedNote = null;
    this.memory = [];
    this.failed = null;
    this.lastSignature = "";
    this.lastReason = null;
    this.state = "active";
    this.generation++; // discard any reply still in flight from the old puzzle
    this.inFlight = false;
  }

  // Bumped whenever the character learns something (done/rejected/gave up/a
  // refusal). Part of its decision signature so new information always earns
  // a fresh decision, even when the board itself did not change.
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
    if (this.declinedNote) return this.declinedNote;
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

  // Called every dispatch tick with this character's perspective. Only starts
  // a model call when something it cares about actually changed.
  consider(signature: string, prompt: string, system: string) {
    if (this.failed) return;
    if (this.inFlight && this.now() - this.thinkingSince > THINKING_TIMEOUT_MS) {
      this.inFlight = false;
      this.failed = "no answer after 30s";
      this.generation++; // the late reply, if it ever arrives, is stale now
      return;
    }
    if (signature === this.lastSignature || this.inFlight) return;
    const cooldown = CALL_COOLDOWN_MS * 2 ** Math.min(this.rejectStreak, 4);
    if (this.now() - this.lastCallAt < cooldown) return;
    if (!this.spendCall()) {
      this.failed = "crew call budget for this puzzle used up";
      return;
    }
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
      if (gen !== this.generation) return; // stale: timed out or puzzle reset
      this.onReply(reply);
    } catch (err) {
      if (gen !== this.generation) return;
      this.failed = err instanceof Error ? err.message.slice(0, 120) : "request failed";
    } finally {
      if (gen === this.generation) this.inFlight = false;
    }
  }

  private onReply(reply: MoveReply) {
    const action = reply.action === "claim" || reply.action === "help" || reply.action === "decline" ? reply.action : null;
    const piece = normalizePieceRef(reply.piece);
    const reason = String(reply.reason ?? "").trim().slice(0, 140);
    if (action === "decline") {
      // An explicit refusal: visible on this character's line, told to the
      // asker by the crew, and it commits this mind to nothing.
      this.committed = null;
      if (piece) {
        this.declinedNote = `declined the ask for ${piece}`;
        this.lastReason = reason || null;
        this.remember(`you declined the ask for ${piece}`);
        this.events.onDecline(this.id, piece, reason);
      }
      return;
    }
    if (!action || !piece) {
      // "wait" or garbage: a valid choice, just no commitment. A refusal
      // stays on the character's line until it commits to something else.
      this.committed = null;
      return;
    }
    this.declinedNote = null;
    this.committed = { action, piece, reason: reason || `${this.name} chose ${piece}`, at: this.now() };
    this.lastReason = reason || null;
  }

  // The engine accepted this mind's move (it is now really happening).
  noteApplied(what: string) { this.remember(`done: ${what}`); this.committed = null; this.rejectStreak = 0; }
  // The move did not hold (piece taken, partner vanished, state moved on).
  noteRejected(why: string) { this.remember(`rejected: ${why}`); this.committed = null; this.rejectStreak++; }
  // A beam lead gave up waiting for a partner.
  noteExpired(why: string) { this.remember(`gave up: ${why}`); this.committed = null; this.rejectStreak++; }
}

interface Board { claim: Map<string, string>; helpWanted: Map<string, string>; helping: Map<string, string> }

function normalizePieceRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = ref.trim().toLowerCase().replace(/\s+/g, "-").match(/^(block|beam)-?(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// The crew of minds: one CharacterMind per mii, sharing an intention board.
export class MindfulCrew implements CrewController {
  private minds = new Map<string, CharacterMind>();
  private calls = 0;
  private appliedCount = 0;
  // piece -> (mindId -> reason): explicit refusals against an open beam ask.
  private declines = new Map<string, Map<string, string>>();
  private emitted = new Map<string, AssignmentDecision>(); // mindId -> decision awaiting engine outcome
  private lastView: DecisionView | null = null;
  readonly modelLabel: string;

  constructor(private caller: JsonCaller, private now: () => number = () => Date.now()) {
    this.modelLabel = `${caller.model} (${caller.provider === "openai" ? "OpenAI" : "Ollama"})`;
  }

  newPuzzle() {
    this.calls = 0;
    this.emitted.clear();
    this.declines.clear();
    for (const m of this.minds.values()) m.newPuzzle();
  }

  // A character openly refused an ask: the asker is told who and why, so it
  // KNOWS rather than inferring silence. When every other free character has
  // declined, the asker's commitment is released so it can choose anew.
  private onDecline = (mindId: string, piece: string, reason: string) => {
    let forPiece = this.declines.get(piece);
    if (!forPiece) { forPiece = new Map(); this.declines.set(piece, forPiece); }
    forPiece.set(mindId, reason);
    const view = this.lastView;
    const askerId = this.board().helpWanted.get(piece) ?? [...this.minds.values()].find((m) => m.committed?.action === "claim" && m.committed.piece === piece)?.id;
    const asker = askerId ? this.minds.get(askerId) : undefined;
    if (!view || !asker) return;
    const who = view.members.find((m) => m.id === mindId)?.name ?? mindId;
    asker.remember(`declined: ${who} declined your ask for ${piece}${reason ? ` ("${reason}")` : ""}`);
    const reallyAll = view.members.filter((m) => m.free && m.id !== askerId).every((m) => forPiece!.has(m.id));
    if (reallyAll) asker.noteExpired(`everyone declined your ask for ${piece}`);
  };

  private spendCall = () => ++this.calls <= MAX_CALLS_PER_PUZZLE ? true : (this.calls--, false);

  private mindFor(id: string, name: string): CharacterMind {
    let m = this.minds.get(id);
    if (!m) { m = new CharacterMind(id, name, this.caller, this.spendCall, this.now, { onDecline: this.onDecline }); this.minds.set(id, m); }
    return m;
  }

  // What every character can see: committed intentions of the others.
  // Two minds committing to the same piece: the earlier commitment stands and
  // the later one is told it lost (its mind re-decides) - never silently
  // overwritten, or that character would stall waiting on a dead intention.
  private board(): Board {
    const claim = new Map<string, string>();      // piece -> mindId
    const helpWanted = new Map<string, string>(); // piece -> lead mindId
    const helping = new Map<string, string>();    // mindId -> piece (accepted to help)
    const ordered = [...this.minds.entries()]
      .filter(([, m]) => m.committed)
      .sort((a, b) => a[1].committed!.at - b[1].committed!.at);
    for (const [id, m] of ordered) {
      const p = this.lastView?.pieces.find((q) => q.id === m.committed!.piece);
      if (!p) { m.noteRejected(`${m.committed!.piece} is not on the board`); continue; }
      if (m.committed!.action === "claim" && !p.heavy) {
        if (claim.has(p.id)) { m.noteRejected(`${p.id} was taken by ${claim.get(p.id)}`); continue; }
        claim.set(p.id, id);
      } else if (m.committed!.action === "claim" && p.heavy) {
        if (helpWanted.has(p.id)) { m.noteRejected(`${p.id} already has a lead asking for help`); continue; }
        helpWanted.set(p.id, id);
      } else if (m.committed!.action === "help") {
        if (!helpWanted.has(p.id)) { m.noteRejected(`no open ask for ${p.id} (already covered or withdrawn)`); continue; }
        helping.set(id, p.id);
      }
    }
    return { claim, helpWanted, helping };
  }

  decide(view: DecisionView): ControllerReply {
    this.lastView = view;
    const now = this.now();
    // Outcome feedback from the PREVIOUS emission: applied() clears accepted
    // moves synchronously in the same tick, so anything still here was
    // rejected by the engine (piece not placeable, carrier no longer free).
    for (const [mindId, prev] of this.emitted) {
      this.minds.get(mindId)?.noteRejected(`${prev.piece} could not be started (taken or blocked)`);
    }
    this.emitted.clear();
    for (const piece of [...this.declines.keys()]) {
      const p = view.pieces.find((q) => q.id === piece);
      if (!p || p.claimed || p.placed) {
        this.declines.delete(piece);
        for (const m of this.minds.values()) m.clearDeclinedNote(piece);
        continue;
      }
      const askLive = [...this.minds.values()].some((m) => m.committed?.action === "claim" && m.committed.piece === piece);
      if (!askLive) this.declines.delete(piece);
    }
    const board = this.board();

    // Expire beam leads whose partner never came, so they reconsider.
    for (const [piece, leadId] of board.helpWanted) {
      const lead = this.minds.get(leadId);
      if (lead?.committed && now - lead.committed.at > PARTNER_WAIT_MS && !board.helping.has(leadId)) {
        // still unmatched (no helper committed toward this piece)
        const hasHelper = [...this.minds.values()].some((m) => m.committed?.action === "help" && m.committed.piece === piece);
        if (!hasHelper) lead.noteExpired(`nobody was free to help with ${piece}`);
      }
    }

    // Let each free character reconsider from its own perspective.
    for (const mem of view.members) {
      const mind = this.mindFor(mem.id, mem.name);
      if (!mem.free) { continue; }
      if (mind.unusable) continue;
      // Holding a still-viable intention is a decision too: no new call while
      // the piece is still open / the ask is still unanswered.
      if (mind.committed && commitmentViable(mind.committed, view, board)) continue;
      const signature = agentSignature(mem.id, view, board, mind);
      const prompt = buildAgentPrompt(mem.id, view, board, this.minds, this.declines);
      const system = `You are ${mem.name}, one of a small crew of island miis building a bridge together. You decide for yourself - nobody assigns you jobs. You see what the others announced and can claim work or answer a call for help. Reply only with JSON matching the schema.`;
      mind.consider(signature, prompt, system);
    }

    // Turn committed moves into engine decisions.
    const decisions: AssignmentDecision[] = [];
    const decisionFrom = new Map<string, string>(); // decision key -> mindId for outcome feedback
    const nextBoard = this.board();
    const usedMembers = new Set<string>();
    const claimedPieces = new Set<string>();

    // Solo blocks first: a claim emits immediately.
    for (const [piece, mindId] of nextBoard.claim) {
      if (claimedPieces.has(piece) || usedMembers.has(mindId)) continue;
      claimedPieces.add(piece); usedMembers.add(mindId);
      decisions.push({ piece, lead: mindId });
      decisionFrom.set(`${piece}:${mindId}`, mindId);
    }
    // Beams: only where a lead's request met an independent acceptance.
    for (const [piece, leadId] of nextBoard.helpWanted) {
      if (claimedPieces.has(piece) || usedMembers.has(leadId)) continue;
      const helper = [...this.minds.entries()].find(([id, m]) =>
        m.committed?.action === "help" && m.committed.piece === piece && id !== leadId && !usedMembers.has(id));
      if (!helper) continue; // request still open - waiting on a partner's own choice
      claimedPieces.add(piece); usedMembers.add(leadId); usedMembers.add(helper[0]);
      decisions.push({ piece, lead: leadId, helper: helper[0] });
      decisionFrom.set(`${piece}:${leadId}`, leadId);
      decisionFrom.set(`${piece}:${helper[0]}:helper`, helper[0]);
    }

    for (const d of decisions) {
      const leadMind = decisionFrom.get(`${d.piece}:${d.lead}`);
      if (leadMind) this.emitted.set(leadMind, d);
      if (d.helper) {
        const h = decisionFrom.get(`${d.piece}:${d.helper}:helper`);
        if (h) this.emitted.set(h, d);
      }
    }

    const builtinFor = view.members.filter((m) => m.free && this.mindFor(m.id, m.name).unusable).map((m) => m.id);
    if (!decisions.length && builtinFor.length === view.members.filter((m) => m.free).length && builtinFor.length) {
      return "fallback"; // every free character is on built-in: let the engine just run it
    }
    if (!decisions.length && !builtinFor.length) return "pending";
    return { decisions, builtinFor };
  }

  applied(a: AssignmentDecision): void {
    this.appliedCount++;
    for (const id of [a.lead, a.helper]) {
      if (!id) continue;
      this.emitted.delete(id);
      this.minds.get(id)?.noteApplied(`${a.piece} (${id === a.lead ? "carrying" : "helping"})`);
    }
  }

  statuses(): MindStatus[] {
    return [...this.minds.values()].map((m) => m.status(this.modelLabel));
  }

  stats(): { calls: number; decisionsApplied: number } {
    return { calls: this.calls, decisionsApplied: this.appliedCount };
  }
}

function commitmentViable(c: { action: "claim" | "help"; piece: string }, view: DecisionView, board: Board): boolean {
  const p = view.pieces.find((q) => q.id === c.piece);
  if (!p || p.placed) return false;
  if (p.claimed) return false; // engine already owns it (someone got there)
  if (c.action === "claim") return !board.claim.has(p.id) || board.claim.get(p.id) !== undefined;
  // help stays viable while the ask it answers is still open
  return [...board.helpWanted.keys()].includes(c.piece);
}

function agentSignature(memId: string, view: DecisionView, board: Board, mind: CharacterMind): string {
  const placeable = view.pieces.filter((p) => p.placeable).map((p) => p.id).sort().join(",");
  const free = view.members.filter((m) => m.free).map((m) => m.id).sort().join(",");
  const claims = [...board.claim.entries()].map(([p, m]) => `${p}=${m}`).sort().join(",");
  const wants = [...board.helpWanted.entries()].map(([p, m]) => `${p}=${m}`).sort().join(",");
  const helps = [...board.helping.entries()].map(([m, p]) => `${m}=${p}`).sort().join(",");
  const committed = mind.committed ? `${mind.committed.action}:${mind.committed.piece}` : "none";
  return [placeable, free, claims, wants, helps, committed, `mv${mind.memoryVersion}`].join("|");
}

function buildAgentPrompt(
  memId: string,
  view: DecisionView,
  board: Board,
  minds: Map<string, CharacterMind>,
  declines: Map<string, Map<string, string>>,
): string {
  const me = view.members.find((m) => m.id === memId)!;
  const nameOf = (id: string) => view.members.find((m) => m.id === id)?.name ?? id;
  const mind = minds.get(memId);
  const others = view.members.filter((m) => m.id !== memId);
  const pieceLine = (p: DecisionView["pieces"][number]) => {
    const mine = p.distances.find((d) => d.member === memId)?.d;
    return `- ${p.id} (${p.heavy ? "beam - HEAVY, needs TWO carriers" : "block - one carrier"}), lying at (${p.home.x},${p.home.y}), fills gap (${p.target.x},${p.target.y}). Your distance: ${mine ?? "?"} tiles.`;
  };
  const placeable = view.pieces.filter((p) => p.placeable);
  const waiting = view.pieces.filter((p) => !p.placed && !p.claimed && !p.placeable);
  const announcements: string[] = [];
  for (const [piece, mid] of board.claim) announcements.push(`${nameOf(mid)} is fetching ${piece} (a block).`);
  for (const [piece, mid] of board.helpWanted) {
    const ds = declines.get(piece);
    const refusals = ds?.size ? ` Declined by: ${[...ds.keys()].map(nameOf).join(", ")}.` : "";
    announcements.push(`${nameOf(mid)} wants to lift ${piece} (a beam) and is ASKING for a partner.${refusals}`);
  }
  for (const [mid, piece] of board.helping) announcements.push(`${nameOf(mid)} agreed to help lift ${piece}.`);
  const memory = mind?.memoryLines() ?? [];

  return `You are ${me.name}. The crew is building a bridge across a river; each gap cell needs one piece carried over and placed. Blocks need one carrier. Beams are heavy and only move when TWO miis carry them together.

You decide for yourself. There is no leader. You see the others' announced intentions below, and they see yours.

Your position: (${me.x},${me.y}). You are ${me.free ? "free" : "busy"}.
Other crew: ${others.map((o) => `${o.name} (${o.free ? "free" : "busy"})`).join(", ") || "none"}.

Announced intentions:
${announcements.join("\n") || "(nobody has announced anything yet)"}

Pieces that CAN be placed right now (someone can reach the spot next to their gap):
${placeable.map(pieceLine).join("\n") || "(none)"}
${waiting.length ? `\nNot placeable yet (the bridge must grow toward them first): ${waiting.map((p) => p.id).join(", ")}` : ""}
${view.inProgress.length ? `\nAlready being carried/placed: ${view.inProgress.map((w) => `${w.piece} with ${nameOf(w.lead)}${w.helper ? ` + ${nameOf(w.helper)}` : ""}`).join("; ")}` : ""}
${memory.length ? `\nWhat happened to your recent choices:\n${memory.map((l) => `- ${l}`).join("\n")}` : ""}

Choose your own next move:
- "claim" a placeable piece id to carry it yourself. For a beam this is also a public ASK for a partner; the lift only starts when another mii independently answers.
- "help" with a piece id that has an open beam ask above, if you want to be that partner.
- "decline" a piece id with an open ask if you do NOT want to join it - the asker is openly told you refused. You can still do other work afterwards.
- "wait" if nothing makes sense for you right now; waiting says nothing either way about an open ask.
Never claim a piece someone already announced. Never help or decline without an open ask. Use piece ids exactly as listed (e.g. block-0). reason: one short sentence in your own voice.`;
}
