// LLM crew planner for the bridge puzzle (the "Crew control" panel).
// A visitor connects their own model - their OpenAI key or their own Ollama,
// same setup storage and key handling as the conversation playground - and
// the model then CHOOSES the crew's jobs: which piece to work next and who
// carries it. Everything mechanical (pathing, carrying, two-mii lifts,
// placing, crossing) stays in puzzle-engine.ts, and the engine revalidates
// every decision, so a model can never make an illegal move - at worst its
// answer is rejected and the built-in assigner covers the tick.
//
// Honesty rules this module keeps:
// - The UI status always names the actual driver: the model while it is
//   answering, "thinking" while a call is in flight, and built-in logic with
//   the reason whenever the model is not connected, unreachable, or returned
//   an unusable plan.
// - A slow model never freezes the game: after THINKING_TIMEOUT_MS without an
//   answer the built-in assigner takes over and the status says why.
// - One in-flight call at a time, and a new call only when the decision
//   surface actually changed (a piece got placed, someone freed up): each
//   OpenAI call spends the visitor's own key.
import type { JsonCaller } from "../server/llm-json.ts";
import type {
  AssignmentDecision, ControllerReply, CrewController, DecisionView,
} from "./puzzle-engine.ts";

export type BrainState = "thinking" | "active" | "fallback";
export interface BrainStatus {
  state: BrainState;
  modelLabel: string; // e.g. "gpt-6-luna (OpenAI)" or "gemma4-pi (Ollama)"
  detail: string; // honest human-readable driver line for the UI
  calls: number; // model calls made
  decisionsApplied: number; // assignments the engine accepted (counted via markApplied)
  lastReason: string | null; // the model's own one-line reason for its latest choice
  lastError: string | null;
}

const THINKING_TIMEOUT_MS = 30_000;
// Hard per-request bounds, so cost on the visitor's key is enforceable rather
// than estimated: prompts are character-capped (<= ~2000 tokens worst case)
// and completions are capped server-side (OpenAI max_completion_tokens /
// Ollama num_predict; reasoning tokens included on OpenAI).
const MAX_PROMPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 2000;
// Structural cost bound: each call spends the visitor's own key, so a puzzle
// never exceeds this many model calls no matter how the surface changes.
// Normal puzzles take 3-8; the cap only stops pathological re-planning.
const MAX_CALLS_PER_PUZZLE = 25;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          piece: { type: "string" },
          lead: { type: "string" },
          helper: { type: "string" },
          reason: { type: "string" },
        },
        required: ["piece", "lead", "helper", "reason"],
      },
    },
  },
  required: ["assignments"],
};

interface PlanReply { assignments?: { piece?: string; lead?: string; helper?: string; reason?: string }[] }

export class PuzzleBrain implements CrewController {
  private plan: AssignmentDecision[] | null = null;
  private reasons = new Map<string, string>();
  private inFlight = false;
  private failed: string | null = null;
  private lastSignature = "";
  private thinkingSince = 0;
  private calls = 0;
  private appliedCount = 0;
  private lastReason: string | null = null;
  readonly modelLabel: string;

  constructor(private caller: JsonCaller, private now: () => number = () => Date.now()) {
    this.modelLabel = `${caller.model} (${caller.provider === "openai" ? "OpenAI" : "Ollama"})`;
  }

  // New puzzle layout: clear the old plan and give the model a fresh chance
  // (a previous failure does not carry into a new puzzle).
  newPuzzle() {
    this.calls = 0;
    this.plan = null;
    this.reasons.clear();
    this.failed = null;
    this.lastSignature = "";
    this.lastReason = null;
  }

  // The engine calls this after accepting a decision, so the panel can count
  // moves the model actually made (not just suggested).
  applied(a: AssignmentDecision) {
    this.appliedCount++;
    const r = this.reasons.get(`${a.piece}:${a.lead}`);
    if (r) this.lastReason = r;
  }

  status(): BrainStatus {
    let detail: string;
    if (this.failed) detail = `Built-in logic - model unavailable (${this.failed})`;
    else if (this.inFlight && !this.plan) detail = `${this.modelLabel} is choosing the crew's jobs…`;
    else if (this.plan) detail = `Crew jobs chosen by ${this.modelLabel}`;
    else detail = `${this.modelLabel} connected`;
    return {
      state: this.failed ? "fallback" : this.inFlight && !this.plan ? "thinking" : "active",
      modelLabel: this.modelLabel,
      detail,
      calls: this.calls,
      decisionsApplied: this.appliedCount,
      lastReason: this.lastReason,
      lastError: this.failed,
    };
  }

  decide(view: DecisionView): ControllerReply {
    if (this.failed) return "fallback";
    if (this.inFlight && this.now() - this.thinkingSince > THINKING_TIMEOUT_MS) {
      this.inFlight = false;
      this.failed = "no answer after 30s";
      return "fallback";
    }
    const signature = viewSignature(view);
    if (signature !== this.lastSignature && !this.inFlight && this.calls < MAX_CALLS_PER_PUZZLE) {
      this.lastSignature = signature;
      void this.refresh(view);
    }
    if (this.plan) {
      const usable = this.plan.filter((a) => validAgainstView(a, view));
      if (usable.length) return usable;
      // The stored plan no longer fits the live state; wait for the refresh.
    }
    if (this.calls >= MAX_CALLS_PER_PUZZLE && !this.inFlight) {
      // Budget exhausted with nothing usable left: hand over, don't stall.
      this.failed = `call budget for this puzzle used up (${MAX_CALLS_PER_PUZZLE})`;
      return "fallback";
    }
    return "pending"; // a call is in flight or about to start
  }

  private async refresh(view: DecisionView) {
    this.inFlight = true;
    this.thinkingSince = this.now();
    this.calls++;
    try {
      const reply = await this.caller.callJson<PlanReply>(buildPrompt(view).slice(0, MAX_PROMPT_CHARS), PLAN_SCHEMA, {
        system: "You coordinate a tiny crew of island miis building a bridge in a cozy puzzle game. Reply only with JSON matching the schema.",
        temperature: 0.4,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      const { plan, reasons } = parsePlan(reply, view);
      if (!plan.length) {
        this.failed = "model returned no usable move";
        return;
      }
      this.plan = plan;
      this.reasons = reasons;
    } catch (err) {
      this.failed = err instanceof Error ? err.message.slice(0, 120) : "request failed";
    } finally {
      this.inFlight = false;
    }
  }
}

function viewSignature(view: DecisionView): string {
  const pieces = view.pieces.filter((p) => p.placeable).map((p) => p.id).sort().join(",");
  const free = view.members.filter((m) => m.free).map((m) => m.id).sort().join(",");
  const open = view.pieces.filter((p) => !p.placed && !p.claimed).map((p) => p.id).sort().join(",");
  return `${pieces}|${free}|${open}`;
}

// Validate the model's plan against the view it was answered for. The engine
// re-validates against live state before applying; this pass drops nonsense
// early and keeps the model's reasons for the moves it actually made.
function parsePlan(reply: PlanReply, view: DecisionView): { plan: AssignmentDecision[]; reasons: Map<string, string> } {
  const plan: AssignmentDecision[] = [];
  const reasons = new Map<string, string>();
  const used = new Set<string>();
  for (const raw of reply.assignments ?? []) {
    const piece = view.pieces.find((p) => p.id === raw.piece && p.placeable);
    if (!piece) continue;
    const lead = view.members.find((m) => m.id === raw.lead && m.free);
    if (!lead || used.has(lead.id)) continue;
    if (piece.heavy) {
      const helper = view.members.find((m) => m.id === raw.helper && m.free);
      if (!helper || helper.id === lead.id || used.has(helper.id)) continue;
      used.add(lead.id); used.add(helper.id);
      plan.push({ piece: piece.id, lead: lead.id, helper: helper.id });
    } else {
      used.add(lead.id);
      plan.push({ piece: piece.id, lead: lead.id });
    }
    const reason = String(raw.reason ?? "").trim().slice(0, 140);
    if (reason) reasons.set(`${piece.id}:${lead.id}`, reason);
  }
  return { plan, reasons };
}

function validAgainstView(a: AssignmentDecision, view: DecisionView): boolean {
  const piece = view.pieces.find((p) => p.id === a.piece);
  if (!piece || !piece.placeable) return false;
  const lead = view.members.find((m) => m.id === a.lead && m.free);
  if (!lead) return false;
  if (piece.heavy) {
    const helper = view.members.find((m) => m.id === a.helper && m.free);
    if (!helper || helper.id === lead.id) return false;
  } else if (a.helper) return false;
  return true;
}

function buildPrompt(view: DecisionView): string {
  const freeNames = view.members.filter((m) => m.free).map((m) => `${m.name} (${m.id})`);
  const busy = view.members.filter((m) => !m.free).map((m) => m.name);
  const placeable = view.pieces.filter((p) => p.placeable);
  const waiting = view.pieces.filter((p) => !p.placed && !p.claimed && !p.placeable);
  const pieceLine = (p: DecisionView["pieces"][number]) =>
    `- ${p.id} (${p.heavy ? "beam - HEAVY, needs a lead AND a helper" : "block - one carrier"}), lying at (${p.home.x},${p.home.y}), fills gap (${p.target.x},${p.target.y}). Distance in tiles: ${p.distances.map((d) => `${d.member} ${d.d}`).join(", ") || "n/a"}`;
  return `The crew is building a bridge across a river. Each gap cell needs one piece carried over and placed into it. Blocks need one carrier. Beams are heavy: they only move when TWO miis carry them together (a lead and a helper).

Free crew right now: ${freeNames.join(", ") || "nobody"}${busy.length ? `\nBusy crew (do not assign): ${busy.join(", ")}` : ""}

Pieces that CAN be placed right now (a crew member can reach the spot next to their gap):
${placeable.map(pieceLine).join("\n") || "(none)"}
${waiting.length ? `\nNot placeable yet (their gap spot is still cut off by water - the bridge must grow toward them first): ${waiting.map((p) => p.id).join(", ")}` : ""}
${view.inProgress.length ? `\nAlready in progress: ${view.inProgress.map((w) => `${w.piece} with ${w.lead}${w.helper ? ` + ${w.helper}` : ""} (${w.state})`).join("; ")}` : ""}

Choose which pieces to start on now and who carries each. Rules:
- Only pick pieces listed as placeable right now.
- Only assign free crew members, each at most once.
- A beam needs a lead AND a different helper. A block takes only a lead (leave helper empty).
- You do not have to assign every piece - starting fewer is fine.
- reason: one short sentence the player can read, saying why this choice makes sense.`;
}
