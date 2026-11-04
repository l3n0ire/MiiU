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
  // Layout seed for modes that generate one (expedition, maze); null for
  // fixed-layout modes (puzzle, crossing).
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

// Like-for-like comparison: same mode, and same layout where seeds exist.
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

export function formatScore(run: RunRecord): string {
  return `${Math.round(run.elapsed)}s`;
}

// One-line summary for win banners: score plus context when a best exists.
export function bannerLine(run: RunRecord, runs: RunRecord[]): string {
  const rank = rankOf(run, runs);
  const pool = runs.filter((r) => comparable(r, run));
  const scope = run.seed != null ? "on this layout" : `in ${run.mode}`;
  if (rank === 1 && pool.length > 1) return `New best ${scope}: ${formatScore(run)}`;
  if (pool.length > 1) return `${formatScore(run)} - #${rank} of ${pool.length} runs ${scope}`;
  return `Finished in ${formatScore(run)} of island time`;
}
