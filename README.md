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
