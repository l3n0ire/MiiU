// Puzzle scoring: a run's score IS its time to completion.
// Lower is better; equal completion times are equal scores (no tiebreakers).
// Raw speed-scaled island seconds are stored, so a normalized formula
// (per-layout par, bonuses, ...) can be layered on later without
// migrating saved history.
//
// Comparability is like-for-like: runs rank within the same mode, and
// within the same layout seed for modes that have one. History is
// visitor-local (this browser's localStorage) - not a shared leaderboard.
//
// Completion boundary: the module scores whatever the engine reports as
// "complete". Mode-specific rules (e.g. the Stone Maze may finish with a
// captive left behind, per #52) stay in the engines - scoring adds no
// extra requirements or penalties.
//
// Speed caveat: elapsed is NOT exactly speed-invariant. Engines accumulate
// it in per-tick chunks of dt*speed and dispatch rounds (every 0.4s island
// time) discard sub-round overshoot, so raw completion time drifts with
// playback speed. Measured case (built-in maze, seed 7): 154.5s at 1x vs
// 155.0s at 4x (0.5s). That is one measurement, not a proved bound -
// higher speeds, longer runs or different frame pacing can drift more, so
// treat cross-speed comparisons as approximate. Exact invariance needs a
// fixed-step simulation core in the engines - a follow-up engine change,
// not a scoring-module fix.

export type PuzzleMode = "puzzle" | "crossing" | "expedition" | "maze";

// Who drove the crew. Actual control can be mixed per character or fall
// back mid-run, so the caller derives the label: "builtin" when no model
// calls were made, "model" when every decision came from the model,
// "mixed" otherwise.
export type RunDriver = "builtin" | "model" | "mixed";

// Formula identifier stamped on every record. v1: score is raw elapsed
// island seconds, lower is better, ties stay tied.
export const FORMULA_VERSION = "island-seconds-v1";

export interface RunRecord {
  mode: PuzzleMode;
  // Layout seed from the engine's state(). All four current modes generate
  // seeded layouts (puzzle.ts and crossing.ts re-randomize on "New puzzle"),
  // so call sites must pass the actual seed. null means the engine did not
  // report one: unknown-seed runs compare within the mode only, never as
  // same-layout.
  seed: number | null;
  driver: RunDriver;
  // Model name when a model was connected (e.g. "qwen2.5:0.5b"), else null.
  model: string | null;
  // Sharing on/off where the mode has the toggle, else null.
  sharing: boolean | null;
  // Score input: speed-scaled island seconds to reach "complete".
  elapsed: number;
  // Model calls used (metadata only - never affects the score), else null.
  calls: number | null;
  // Playback speed the run was viewed at (metadata only). Island seconds
  // already exclude playback speed; recorded because model latency can
  // still influence outcomes differently at different speeds.
  speed: number;
  // ISO timestamp of completion.
  at: string;
}

export interface ScoredRun extends RunRecord {
  score: number;
}

export const HISTORY_KEY = "miiu-puzzle-scores-v1";
export const MAX_HISTORY_PER_MODE = 100;

// The score: completion time in island seconds. Lower is better.
export function scoreOf(run: RunRecord): number {
  return run.elapsed;
}

// Like-for-like comparison: same mode, and same layout seed. A null seed
// means the layout is unknown, so such runs compare within the mode only.
export function comparable(a: RunRecord, b: RunRecord): boolean {
  return a.mode === b.mode && a.seed === b.seed;
}

// Ordering for display: faster completion ranks higher. Equal completion
// times are EQUAL (0) - Daniel's spec scores by time only, so there are
// no tiebreakers. Tied runs share a rank.
export function compareRuns(a: RunRecord, b: RunRecord): number {
  return a.elapsed - b.elapsed;
}

export function bestRun(runs: RunRecord[], of: RunRecord): ScoredRun | null {
  const pool = runs.filter((r) => comparable(r, of));
  if (!pool.length) return null;
  const best = pool.reduce((m, r) => (compareRuns(r, m) < 0 ? r : m));
  return { ...best, score: scoreOf(best) };
}

// Rank among comparable recorded runs, 1 = best. Ties share the better
// rank. Includes the candidate itself, so a new best returns 1.
export function rankOf(run: RunRecord, runs: RunRecord[]): number {
  return runs.filter((r) => comparable(r, run) && compareRuns(r, run) < 0).length + 1;
}

// Minimal storage shape so tests and non-browser callers can substitute.
export interface ScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Versioned on-disk schema; bump and migrate when it changes.
type HistoryFile = { version: 1; runs: RunRecord[] };

export function loadHistory(storage: ScoreStorage): RunRecord[] {
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) return [];
    return parsed.runs;
  } catch {
    return [];
  }
}

export function recordRun(storage: ScoreStorage, run: RunRecord): ScoredRun {
  const runs = loadHistory(storage);
  runs.push(run);
  // Keep the newest MAX_HISTORY_PER_MODE per mode.
  const kept: RunRecord[] = [];
  for (const mode of new Set(runs.map((r) => r.mode))) {
    const own = runs.filter((r) => r.mode === mode);
    kept.push(...own.slice(-MAX_HISTORY_PER_MODE));
  }
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, runs: kept } satisfies HistoryFile));
  return { ...run, score: scoreOf(run) };
}

// One decimal always: whole-second display hides genuine sub-second
// improvements (154.5 vs 155.0 both showed "155s", making a real new best
// look like a tie). Display precision only - the raw score is untouched.
export function formatScore(run: RunRecord): string {
  return `${run.elapsed.toFixed(1)}s`;
}

// Display labels for banner copy; raw mode ids are internal.
const MODE_LABELS: Record<string, string> = {
  maze: "the Stone Maze",
  expedition: "the Hidden Pass",
  puzzle: "the Bridge Puzzle",
  crossing: "the Long Crossing",
};
export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

// One-line summary for win banners: score plus context when a best exists.
// "New best" only when strictly faster than every comparable run - a run
// that ties the best is rank #1 but NOT a new best (times are equal scores).
export function bannerLine(run: RunRecord, runs: RunRecord[]): string {
  const rank = rankOf(run, runs);
  const pool = runs.filter((r) => comparable(r, run));
  const scope = run.seed != null ? "on this layout" : `in ${modeLabel(run.mode)}`;
  const others = pool.filter((r) => r !== run);
  if (others.length > 0 && others.every((r) => compareRuns(r, run) > 0)) {
    return `New best ${scope}: ${formatScore(run)}`;
  }
  if (pool.length > 1) return `${formatScore(run)} - #${rank} of ${pool.length} runs ${scope}`;
  return `Finished in ${formatScore(run)} of island time`;
}
