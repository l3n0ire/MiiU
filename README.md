# MiiU Island

A tiny life-sim where characters you create wander an island and chat with each other. A local LLM (via Ollama) writes every conversation.

## Run

```bash
ollama serve            # if it isn't already running
npm install
npm start               # http://localhost:3000
```

Use a different local model: `MIIU_MODEL=llama3.2:3b npm start`

### Using OpenAI instead of a local model

```bash
cp .env.example .env    # then set MIIU_PROVIDER=openai and OPENAI_API_KEY=sk-...
npm start
```

`npm start` reads `.env` automatically (it's gitignored, so your key stays local). Defaults to `gpt-6-luna`; set `MIIU_MODEL` to use another model.


## Browser version: your island, your model (issue #19)

A fully browser-side build: each visitor gets their **own island**, powered by a model **they** connect - no server to run or pay for. Everything (simulation, saves, model calls) happens in the visitor's tab:

- **OpenAI (bring your own key):** the key is entered in the setup screen, kept only in that browser (memory only, unless "remember on this device" is checked), and sent only to `api.openai.com` when the island talks. The static host only serves files and never receives the key. Anyone with access to the browser profile could use a remembered key, so don't remember it on shared devices.
- **Your own Ollama (experimental):** the browser calls your local Ollama directly. One-time setup on your machine: start Ollama with `OLLAMA_ORIGINS=<this site's origin> ollama serve` so it accepts the site's cross-origin requests, and allow the browser's local-network-access permission if prompted (Chrome gates public sites calling `localhost` behind it). Ollama must run on this computer (`localhost`/`127.0.0.1`); a server on another machine isn't reachable from the hosted page. Fully offline alternative: run the app locally with `npm start` as above.
- **Saves:** the island persists in the browser's localStorage and pauses when the tab closes. Export/import (JSON) moves it between devices; clearing site data erases it.

Build and run the static version locally:

```bash
npm install
npm run build:web   # outputs dist/
npx serve dist      # or any static file server
```

Deploy by hosting `dist/` on any static host (Cloudflare Pages, Netlify, Vercel hobby, GitHub Pages - build command `npm ci && npm run build:web`, output directory `dist`). No paid backend required; there is no multiplayer and no 24/7 background simulation in this mode.

The Node server mode above is unchanged and still works for a shared island or fully local use.

## How it works

- `server/sim.ts`: ticks 5x/sec. Characters walk between landmarks; when two meet (and haven't talked in the last minute), anyone standing nearby joins in (up to 4). Up to 3 conversations run at once (`MIIU_MAX_CHATS`).
- **Conversations**: one LLM call per line, from the speaker's point of view. They see only their own personality, memories and feelings toward the others, plus the transcript so far, and can walk away. Max 8 lines, then a summary call decides each character's memory and mood and each pair's affinity change.
- **Relationship history**: every label/affinity change is recorded with the chat or arrival that caused it; each pair's story shows under History in the resident panel, and hovering a graph edge summarizes the pair with its latest chapter.
- **World events**: the "Make something happen" panel announces news to everyone (or one character), optionally gathers them at a landmark. Each character reacts and remembers it, so it comes up in later conversations.
- **Chat with a mii**: click a resident (or pick up to 4 in the "Chat with a mii" panel) to talk to them yourself. Miis reply in character, remember the conversation, and it nudges their moods and relationships, just like their own chats.
- **Player bonds**: chatting with residents builds their bond with you (visible in their panel). Once a bond is strong enough (same bar as resident bonds), they may invite a newcomer from off-island who arrives "because of you" - same population cap and arrival flow. `MIIU_PLAYER_SPAWNING=off` disables it.
- **The island game (festival rivalry)**: `server/game.ts` adds a code-owned game layer on top of conversation. Two residents run for Festival Host; the others publicly endorse a candidate and can switch sides (switching away from a close bond costs affinity). Every resident has a secret only they know; they can hint at it, tell it privately (one-on-one only), or expose it as island news at a fixed price (-10 with every resident, -20 with the leaker; the subject privately learns the tell-chain). Residents can make verifiable promises - keep a secret until the festival, or tell someone a secret within 10 minutes - which the code settles as kept (+8) or broken (-12, and a mark in the pair's history). All deadlines run on sim-active time, so paused or closed islands don't miss anything. The model writes the dialogue and picks at most one action per line; `game.ts` validates every action against the ledger and prices the consequences. `MIIU_GAME=off` disables it.
- `server/llm.ts`: prompts + structured-output JSON schemas, sent to Ollama or OpenAI.
- `server/world.ts`: types, map, seed characters. State persists to `world.json` (delete it to reset).
- `public/`: canvas map, speech bubbles, news feed, force-directed relationship graph, character panel.

## Bridge puzzle (cooperative goal mode)

The landing page now offers two experiences: the classic **Conversation Playground** and the **Bridge Puzzle**. In the puzzle, your island crew (read from the same browser save, never written) works together on a visible goal: fetch two blocks and one heavy beam, extend a bridge across the river piece by piece, and cross to the flag. Blocks take one mii; the beam only moves when two lift it together.

- **Action-first:** the scene is meant to read from movement alone - fetching, carrying, helping, placing. Short chatter lines are hidden by default behind a "Show chatter" toggle.
- **Generated layouts, emergent order:** each puzzle is generated from a seed (river position, bridge row, piece kinds and homes, flag). Which piece can be placed next is discovered from walkability - a gap cell's stand cell only becomes reachable once the cell before it is filled - so placement order is emergent, not scripted. Jobs are assigned greedily by distance among free members and re-evaluated every tick; the two-carrier rule on beams is a mechanic, with dynamic helper recruitment.
- **Honest limits:** by default this is a deterministic, code-driven task assigner (`web/puzzle-engine.ts`) - not a general planner with backtracking, not learned behavior, and the miis do not negotiate. No model connection or API key is needed.
- **Optional model control ("Crew control" panel):** connect your own model - an OpenAI key or your own Ollama, same setup and key handling as the playground - and EVERY mii decides for itself (`web/puzzle-minds.ts`): its own calls, its own memory, its own choice to claim work, ask for a lift partner, answer another mii's ask, or openly decline it. Coordination happens through a shared intention board, never a central planner; the engine revalidates every decision (and never invents consent - a beam moves only when two independent choices meet), and all walking, lifting, placing and crossing stay code-driven. Hard bounds per puzzle: 40 aggregate calls, 30s per-call timeout, per-request output cap, prompt size cap (call/token bounds, not a dollar cap). If a mii's model is not connected, unreachable, too slow, or returns nonsense, that mii alone falls back to built-in logic and the panel names each character's actual driver.
- **Pure engine + tests:** the engine has no DOM dependencies; `web/puzzle-engine.test.ts` covers layout generation and variety, cooperative completion across seeds, near-to-far placement order, two-carrier enforcement, no crossing before the bridge is done, and seeded determinism. `web/puzzle-minds.test.ts` covers model-driven completion with scripted independent characters, no built-in claims while a mind thinks, per-character honest fallback, rejection of illegal moves, explicit declines (a refusal is not consent and the asker is told), call pacing and budget caps, and lifecycle safety (a reply arriving after timeout or a puzzle reset is discarded before it can touch any state).
- Browser build only for now; the Node server mode (`npm start`) serves the original playground unchanged.

## The Hidden Pass (knowledge-sharing puzzle)

A third puzzle mode about **discovering and sharing knowledge** (`web/expedition-engine.ts`, `web/expedition-minds.ts`, `web/expedition.ts`, `web/expedition.html`). Supplies sit in a grove east of a rock ridge; the camp is west. Everyone knows the long detour around the ridge - but exactly one narrow hidden pass cuts through it, and nobody knows where at the start.

- **Private knowledge:** each mii's map is its own. Pass tiles are impassable in a mii's pathfinding until that mii (a) physically scouts the ridge and discovers the pass itself - proximity while deliberately scouting; walking past on an errand finds nothing - or (b) is told by the crew. A mii's decision prompt contains only what it knows: no pass location, and crate route lengths are computed with its own knowledge so they do not leak the shortcut.
- **Sharing is a choice:** a mii that found the pass can "share" it (the crew's routes re-plan through it) or keep it to itself (only its own trips get shorter). When a connected model drives the crew, sharing is each mii's own decision - nothing shares automatically, and nothing is scripted. With sharing toggled off in setup, the only way to know the pass is to find it yourself.
- **Honest attribution:** the feed credits discoveries ("Pip found a hidden pass..."), shares ("Pip shared it with the crew"), and automatic route re-planning ("Marlo's route automatically updated - it now goes through the pass Pip shared") as exactly what they are - a route change after a share is the engine re-planning with new knowledge, not the other mii reasoning out the pass.
- **Comparison:** restart replays the same layout, and the win banner shows the previous completed run's stats (time, calls, sharing mode) so runs with sharing on vs off can be compared. These are descriptive same-layout comparisons - model choices are stochastic, so they are not a controlled experiment.
- **Budget failure:** the aggregate call budget is adjustable in setup. When it runs out, the run FAILS ("the agents failed to accomplish the task") with a restart-at-a-different-limit option - the built-in logic does not silently finish the task. Per-call timeout/error still switches just that mii to labeled built-in logic.
- **Baseline:** with no model connected, the built-in assigner fetches crates with public knowledge only - it never scouts and never shares, so it always takes the long way.
- **What this does not demonstrate:** real dialogue (coordination is announcements and choices, not conversation), learned behavior, or any claim about how often a given model chooses to share - that is an open, model-dependent question the puzzle is built to let you observe.
- **Tests:** `web/expedition-engine.test.ts` (layout invariants, knowledge-gated reachability, no accidental discovery on errands across 40 seeds, private discovery -> share propagation, automatic route re-planning with feed attribution, sharing-off isolation, decision validation, per-knower route views) and `web/expedition-minds.test.ts` (scripted independent minds complete the run with a genuine scout -> share -> others-use-it arc, prompt privacy including route-length leaks, budget exhaustion fails the run without silent completion, per-mii error fallback, stale-reply discards, adjustable-budget restart).

## The Stone Maze (cooperative contraption puzzle)

A fourth puzzle mode about **cooperation under constraint** in a generated maze (`web/maze-engine.ts`, `web/maze-minds.ts`, `web/maze.ts`, `web/maze.html`). The maze splits into the camp side and the warrens where four supply crates sit; the ONLY public way through is a stone door that opens ONLY while two miis stand holding its two pressure plates at the same time.

- **Someone has to stand still:** one mii cannot finish alone. Holders keep the door open while carriers shuttle crates through; the moment a holder steps off, the door slams shut and a carrier mid-trip waits on its side until it opens again. With a model connected, holding, releasing and going back to fetch are each mii's own decision - nobody assigns jobs.
- **Hidden crack + cache (private knowledge, as in The Hidden Pass):** in most layouts a cracked wall leads to a sealed cache room with a golden bonus crate. It is impassable in a mii's pathfinding until that mii scouts the walls up close and discovers it, or is told by a crewmate who CHOSE to share. The discoverer can keep the shortcut (and the loot) to itself. Errand-running past the wall never reveals it; only deliberate scouting does. The four supply crates win the run - the cache is extra glory.
- **Solvability-checked randomization:** every layout is generated from the seed (iterative-backtracker maze, door position, plate positions, camp, crates, crack and cache room) and REJECTED/regenerated unless a checker proves it solvable: plates, camp and spawns reachable with the door shut; every crate reachable through the open door and ONLY through it; the cache room sealed except through its crack. Restart replays the same layout so runs can be compared (descriptive, not a controlled experiment).
- **The jailer:** a jailer starts near the middle of the completion path (the midpoint of the camp-to-farthest-crate route) and wanders around its post. It has straight-corridor line of sight: spot a mii down a corridor and it runs at it. On contact the mii is dragged to the jail (a camp-side dead end), the jailer vanishes, and a jail key appears somewhere on the map. Another mii can fetch the key and free the captive - then the jailer respawns at its post. It holds only one captive at a time (it is gone while someone is jailed), and the crew can still finish the maze without freeing anyone. After the FIRST capture every mii knows to avoid it: they route around it when they can and drop everything to run when it chases (a fleeing mii outruns it unless cornered). With a model connected, rescuing is each mii's own choice via the "rescue" action; the built-in crew frees the first captive, then finishes the maze rather than chasing later keys.
- **Same autonomy and honesty model:** per-mii decisions and memory when a model is connected; per-character labeled fallback; aggregate call budget with explicit run failure and adjustable-budget restart (no silent built-in takeover); the feed credits door openings, holds, releases, discoveries, shares and automatic route re-planning as exactly what they are. The built-in no-model baseline cooperates by code assignment (two holders, the rest fetch) but never scouts or shares, so it never finds the cache - and the UI says so.
- **What this does not demonstrate:** learned behavior, negotiation dialogue, or any claim about how a given model balances holding vs fetching vs scouting - the puzzle is built to let you observe it.
- **Tests:** `web/maze-engine.test.ts` (solvability-checker invariants over 60 seeds, layout variety and determinism, door physics with waiting carriers, built-in completion over 50 seeds with no accidental discovery, knowledge-gated cache reachability, sharing-off isolation, decision validation, budget-failure latch; jailer: jail placement and post on the completion path, line-of-sight chase and capture with a reachable key, one captive at a time, rescue and respawn, post-capture fleeing, completion without freeing) and `web/maze-minds.test.ts` (scripted independent minds complete the puzzle with a genuine hold/fetch/scout/share/loot arc, prompt privacy including crack coordinates and cache, OFF-sharing prompts never inviting share, adjustable-budget restart, per-mii honest fallback).

## The Long Crossing (harder cooperative puzzle)

A second, harder puzzle mode: **two rivers** with a rocky island between them, and the flag on the far bank (`web/crossing-engine.ts`, `web/crossing.ts`, `web/crossing.html`).

- **Sequencing, not just carrying:** the crew must bridge the near river first, then FERRY materials across it - one of the far bridge's heavy beams starts on the home bank and needs two carriers over bridge one - then build the far bridge and bring everyone across. Six pieces (three heavy beams), four miis.
- **Emergent order again:** far-bank pieces are unreachable until the path to them exists (bridge one plus the nearer far gaps), discovered from walkability rather than scripted; the engine rejects any controller decision that tries to skip ahead.
- **Same autonomy model:** the optional per-character minds (`web/puzzle-minds.ts`, now with a scenario parameter) work here unchanged - every mii makes its own calls and memory, asks for partners, answers or explicitly declines; the shared intention board is how they coordinate. The built-in assigner solves the crossing on its own and the panel names each character's actual driver, exactly as in the bridge puzzle.
- **Tests:** `web/crossing-engine.test.ts` (layout invariants over seeds, far-gap gating, illegal-claim rejection, ferry-beam verification, 100-seed built-in completion, determinism) and `web/crossing-minds.test.ts` (scripted independent minds complete the crossing, scenario briefing reaches prompts, call budget respected, unreachable asks rejected with feedback).
