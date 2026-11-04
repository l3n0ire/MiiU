// UI-side glue between the four puzzle pages and the scoring module
// (web/scoring.ts, owned by the scoring-module PR). This file owns:
// deriving the run's driver label from the crew minds, recording a
// completed run exactly once at the engine's "complete" transition, and
// rendering the per-mode run history panel. No scoring formula lives here.

import {
  recordRun,
  loadHistory,
  bannerLine,
  formatScore,
  compareRuns,
  type RunRecord,
  type RunDriver,
  type PuzzleMode,
  type ScoreStorage,
} from "./scoring.ts";

// The shape the pages' crew controllers share (MindfulCrew, PassMinds,
// MazeMinds): aggregate call stats, per-character statuses, model label.
export interface MindsLike {
  stats(): { calls: number };
  statuses(): { state: string }[];
  modelLabel?: string;
}

// Driver label for history comparisons. Control can be mixed per character
// or fall back mid-run, so: no minds connected (or connected but never
// called) -> "builtin"; at least one character on built-in fallback ->
// "mixed"; otherwise -> "model".
export function deriveDriver(minds: MindsLike | null): RunDriver {
  if (!minds) return "builtin";
  if (minds.stats().calls === 0) return "builtin";
  return minds.statuses().some((s) => s.state === "fallback") ? "mixed" : "model";
}

export interface CompletionInput {
  mode: PuzzleMode;
  seed: number | null;
  minds: MindsLike | null;
  sharing: boolean | null;
  elapsed: number;
  speed: number;
}

// Record one completed run and produce its win-banner line. Call exactly
// once per run, at the engine's "complete" transition. The banner line is
// computed against history INCLUDING this run (rank and "of N" counts are
// about where this run lands), then the run is persisted.
export function recordCompletion(
  storage: ScoreStorage,
  input: CompletionInput,
): { run: RunRecord; line: string } {
  const run: RunRecord = {
    mode: input.mode,
    seed: input.seed,
    driver: deriveDriver(input.minds),
    model: input.minds?.modelLabel ?? null,
    sharing: input.sharing,
    elapsed: input.elapsed,
    calls: input.minds ? input.minds.stats().calls : null,
    speed: input.speed,
    at: new Date().toISOString(),
  };
  const line = bannerLine(run, [...loadHistory(storage), run]);
  recordRun(storage, run);
  return { run, line };
}

// Render the per-mode run history panel: up to 10 fastest completed runs
// in this mode (any layout), newest information first per row. Uses DOM
// nodes with textContent so stored model labels render literally.
export function renderHistory(storage: ScoreStorage, mode: PuzzleMode, el: HTMLElement): void {
  const runs = loadHistory(storage)
    .filter((r) => r.mode === mode)
    .sort(compareRuns)
    .slice(0, 10);
  el.textContent = "";
  if (!runs.length) {
    el.textContent = "No completed runs yet.";
    return;
  }
  runs.forEach((r, i) => {
    const row = el.ownerDocument.createElement("div");
    const layout = r.seed != null ? `layout #${r.seed}` : "unknown layout";
    const date = new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    row.textContent = `#${i + 1} ${formatScore(r)} - ${layout} - ${r.driver}${r.model ? ` ${r.model}` : ""} - ${date}`;
    el.appendChild(row);
  });
}
