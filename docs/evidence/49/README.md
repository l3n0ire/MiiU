# Issue #49 — The Stone Maze (co-op maze puzzle) — evidence

Captured with headless Chrome against a local static build (`dist/`), per
`.claude/skills/miiu-testing/SKILL.md`. All model-driven runs use the
**scripted mock model server** (deterministic, no LLM) named
`scripted-mock-no-llm`, so the pixels label themselves: the driver line reads
`scripted-mock-no-llm (Ollama)` and every mii carries a `[mock]` tag (the UI
swaps `[model]` for `[mock]` whenever the connected model name contains
"mock").

## Files

- `maze-start.png` — fresh generated layout: camp at the west edge, four miis,
  two pressure plates, the stone door (closed), supply crates scattered in the
  warrens east of the door. Dotted lines are current routes.
- `builtin-run.mp4` / `builtin-start.png` / `builtin-win.png` — full run with
  **no model connected** (built-in logic): two miis hold the plates, the door
  opens, the other two fetch all 4 crates. Built-in logic never scouts, so the
  hidden crack stays unfound ("Nobody found a hidden crack this run").
- `mock-model-run.mp4` / `mock-model-win.png` — mock-model run, sharing ON:
  Pip scouts → discovers the crack privately → shares → two holders keep the
  door open → Pip brings home the golden cache crate; 4/4 crates in 43
  one-choice calls.
- `mock-off-run.mp4` / `mock-off-win.png` — mock-model run, sharing OFF:
  Pip discovers the crack, keeps it private (the engine rejects sharing), and
  privately loots the golden cache through the crack while the crew finishes
  4/4 through the held door; 42 one-choice calls.
- `sharing-off-ignorant-prompt.txt` — an actual outgoing prompt (Juniper,
  sharing OFF) captured by the mock server AFTER Pip had privately found the
  crack and was looting the cache. Its shared board shows only public
  activity; nothing about the cache, the crack, or its finder reaches
  non-knowers. Across the whole OFF run, all 28 prompts sent to ignorant
  miis after the private discovery were checked for `cache-0`, any golden
  crate mention, any found/shared crack statement, the actual crack
  coordinates (8,2), cache fetch/carrier lines, and cache-room coordinates:
  zero occurrences. (The pre-review build leaked `"... is fetching cache-0."`
  here — fixed in `maze-engine.ts` `announcements()`, which is now
  per-member; regression-tested in `web/maze-engine.test.ts` and
  `web/maze-minds.test.ts`.)

## Notes

- The mock server is a deterministic test double: it proves the
  engine/prompt/action plumbing end-to-end, not real model behavior. A
  real-model (OpenAI/Ollama) evidence pass is a separate step.
- Layout solvability is checked at generation time (plates/spawns reachable
  with the door shut; crates only reachable through the open door; cache room
  sealed except for its crack), and unit-tested in `web/maze-engine.test.ts`.
