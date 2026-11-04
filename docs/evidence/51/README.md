# Issue #51 — Puzzle scoring UI (win-banner score + run history) — evidence

Captured with headless Chrome against a local static build (`dist/`), per
`.claude/skills/miiu-testing/SKILL.md`. Runs use **no connected model**
(built-in logic), so there is no mock to label; the driver column in the
history panel reads `builtin`.

## Files

- `scoring-history-demo.mp4` — two back-to-back Stone Maze runs on the SAME
  layout (#7) at 4x playback. Run 1 finishes: win banner shows the island-
  time stats and the score line "Finished in 155s of island time"; the Run
  history panel gains its first row. Run 2 (Restart, same layout) finishes:
  the score line reads "New best on this layout: 155s" and the history
  panel shows both runs ranked. Speed toggle was set to 4x for both runs;
  the recorded score is island seconds, unaffected by playback speed.
- `maze-win-history.png` — final frame: win banner (stats, previous-run
  line, score line) and the Run history panel with two ranked entries.
- `maze-mid-run.png` — mid-run frame showing the page during play.

## Notes

- Both runs display 155s yet the second is announced as a new best: raw
  island-seconds differ by under a second (the tick quantization the
  scoring module documents), while the banner displays rounded seconds.
  Comparison is raw; display is rounded — cosmetic only.
- History is visitor-local (localStorage), 100 runs per mode cap.
