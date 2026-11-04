# Issue #51 — Puzzle scoring UI (win-banner score + run history) — evidence

Captured with headless Chrome against a local static build (`dist/`), per
`.claude/skills/miiu-testing/SKILL.md`. Runs use **no connected model**
(built-in logic), so there is no mock to label; the driver column in the
history panel reads `builtin`.

## Files

- `scoring-history-demo.mp4` — two back-to-back Stone Maze runs on the SAME
  layout (#7) at 4x playback, one continuous capture played as a time-lapse
  (about 1 captured frame per real second at 2 fps; no jump cuts or edits).
  Run 1 finishes: the win banner shows the island-time stats only - the
  plain "Finished in ..." score line is suppressed because it would repeat
  the stats - and the Run history panel gains its first row. Run 2
  (Restart, same layout) finishes: the score line reads "New best on this
  layout (improvement below displayed precision)" - the scoring module's
  truthful fallback when a genuine new best is closer to the old best than
  3 display decimals - and the history panel shows both runs ranked on that
  layout. Speed toggle was set to 4x for both runs. Scores are island
  seconds: playback speed is stored as metadata only and never changes
  what a run scores, but island time itself can drift slightly with
  playback speed (tick quantization; the scoring module documents one
  measured built-in maze case of 0.5s between 1x and 4x - a single
  measurement, not a global bound), so cross-speed comparisons are
  approximate.
- `maze-win-history.png` — final frame: win banner (stats, previous-run
  line, score line) and the Run history panel with both runs ranked on
  layout #7.
- `maze-mid-run.png` — mid-run frame showing the page during play.

## Notes

- Both runs display 154.5s (one decimal) yet the second is announced as a
  new best: the raw island-seconds are strictly faster but closer than the
  module's 3-decimal display cap, so the banner uses the generic
  improvement wording instead of repeating an identical number. Comparison
  is raw; display is rounded — cosmetic only.
- History ranks like-for-like only: runs are grouped by layout seed and
  ranks restart inside each layout group, so unlike layouts never rank
  against each other. Each row shows score, layout seed, driver, playback
  speed, and date.
- History is visitor-local (localStorage), 100 runs per mode cap.
