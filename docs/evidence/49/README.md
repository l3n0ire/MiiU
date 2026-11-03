# Issue #49 — The Stone Maze (co-op maze puzzle) — evidence

Captured with headless Chrome against a local static build (`dist/`), per
`.claude/skills/miiu-testing/SKILL.md`.

## Files

- `maze-start.png` — fresh generated layout: camp at the west edge, four miis,
  two pressure plates, the stone door (closed), supply crates scattered in the
  warrens east of the door. Dotted lines are current routes.
- `builtin-run.mp4` / `builtin-start.png` / `builtin-win.png` — full run with
  **no model connected** (built-in logic): two miis walk to the plates and hold,
  the door rumbles open, the other two fetch all 4 crates, run completes.
  Built-in logic never scouts, so the hidden crack stays unfound ("Nobody found
  a hidden crack this run").
- `mock-model-run.mp4` / `mock-model-win.png` — full run against the **scripted
  mock model server** (not a real model; deterministic choices). The mock is
  labeled in the pixels themselves: the driver line reads
  `scripted-mock-no-llm (Ollama)` and every mii carries a `[mock]` tag (the UI
  swaps `[model]` for `[mock]` whenever the connected model name contains
  "mock"). Shows the cooperative arc the engine supports:
  Pip scouts → discovers the hidden crack at (8,2) privately → shares it with
  the crew → two holders keep the door open → Pip slips through the crack and
  brings home the golden cache crate; all 4 supply crates delivered in 43 model
  calls (each "one choice" — no hidden budget takeover).

## Notes

- The mock server is a deterministic test double: it proves the
  engine/prompt/action plumbing end-to-end, not real model behavior. A
  real-model (OpenAI/Ollama) evidence pass is a separate step.
- Layout solvability is checked at generation time (plates/spawns reachable
  with the door shut; crates only reachable through the open door; cache room
  sealed except for its crack), and unit-tested in `web/maze-engine.test.mjs`.
