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

`npm start` reads `.env` automatically (it's gitignored, so your key stays local). Defaults to `gpt-5-mini`; set `MIIU_MODEL` to use another model.

## How it works

- `server/sim.ts`: ticks 5x/sec. Characters walk between landmarks; when two meet (and haven't talked in the last minute), anyone standing nearby joins in (up to 4). Up to 3 conversations run at once (`MIIU_MAX_CHATS`).
- **Conversations**: one LLM call per line, from the speaker's point of view. They see only their own personality, memories and feelings toward the others, plus the transcript so far, and can walk away. Max 8 lines, then a summary call decides each character's memory and mood and each pair's affinity change.
- **World events**: the "Make something happen" panel announces news to everyone (or one character), optionally gathers them at a landmark. Each character reacts and remembers it, so it comes up in later conversations.
- **Chat with a mii**: click a resident (or pick up to 4 in the "Chat with a mii" panel) to talk to them yourself. Miis reply in character, remember the conversation, and it nudges their moods and relationships, just like their own chats.
- `server/llm.ts`: prompts + structured-output JSON schemas, sent to Ollama or OpenAI.
- `server/world.ts`: types, map, seed characters. State persists to `world.json` (delete it to reset).
- `public/`: canvas map, speech bubbles, news feed, force-directed relationship graph, character panel.
