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
  comparable,
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
// line is null when the module's plain "Finished in Xs" text would only
// repeat the completion time the page's win stats already show - the page
// then leaves its score line empty instead of duplicating.
export function recordCompletion(
  storage: ScoreStorage,
  input: CompletionInput,
): { run: RunRecord; line: string | null } {
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
  const history = loadHistory(storage);
  let raw = bannerLine(run, [...history, run]);
  recordRun(storage, run);
  const line = raw === `Finished in ${formatScore(run)} of island time` ? null : raw;
  return { run, line };
}

// Render the per-mode run history panel. Runs only rank like-for-like
// (same mode AND same layout seed, per the module's comparable()), so the
// panel groups by layout: layouts are ordered by their fastest run and
// ranks restart inside each layout group. Up to 10 rows total. Uses DOM
// nodes with textContent so stored model labels render literally.
export function renderHistory(storage: ScoreStorage, mode: PuzzleMode, el: HTMLElement): void {
  const runs = loadHistory(storage).filter((r) => r.mode === mode);
  el.textContent = "";
  if (!runs.length) {
    el.textContent = "No completed runs yet.";
    return;
  }
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = r.seed != null ? `#${r.seed}` : "unknown";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()]
    .map(([key, list]) => ({ key, list: list.sort(compareRuns) }))
    .sort((a, b) => compareRuns(a.list[0], b.list[0]));
  let shown = 0;
  for (const { key, list } of ordered) {
    if (shown >= 10) break;
    if (ordered.length > 1) {
      const head = el.ownerDocument.createElement("div");
      head.textContent = key === "unknown" ? "Unknown layout:" : `Layout ${key}:`;
      head.style.fontWeight = "600";
      el.appendChild(head);
      shown++;
    }
    for (const r of list) {
      if (shown >= 10) break;
      const rank = list.filter((o) => compareRuns(o, r) < 0).length + 1;
      const row = el.ownerDocument.createElement("div");
      const date = new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      // Playback speed is metadata, not part of the score - shown because
      // island time can drift slightly with playback speed (tick
      // quantization), so cross-speed rows are only roughly comparable.
      const layout = key === "unknown" ? "unknown layout" : `layout ${key}`;
      row.textContent = `#${rank} ${formatScore(r)} - ${layout} - ${r.driver}${r.model ? ` ${r.model}` : ""} - ${r.speed}x - ${date}`;
      el.appendChild(row);
      shown++;
    }
  }
}
