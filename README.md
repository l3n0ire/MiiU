# MiiU Island

A tiny life-sim where characters you create wander an island and chat with each other. A local LLM (via Ollama) writes every conversation.

## Run

```bash
ollama serve            # if it isn't already running
npm install
npm start               # http://localhost:3000
```

Use a different model: `MIIU_MODEL=llama3.2:3b npm start`

## How it works

- `server/sim.ts`: ticks 5x/sec. Characters walk between landmarks; when two meet (and haven't talked in the last minute), anyone standing nearby joins in (up to 4). Up to 3 conversations run at once (`MIIU_MAX_CHATS`).
- **Conversations**: one LLM call per line, from the speaker's point of view. They see only their own personality, memories and feelings toward the others, plus the transcript so far, and can walk away. Max 8 lines, then a summary call decides each character's memory and mood and each pair's affinity change.
- **World events**: the "Make something happen" panel announces news to everyone (or one character), optionally gathers them at a landmark. Each character reacts and remembers it, so it comes up in later conversations.
- `server/llm.ts`: prompt + Ollama structured-output JSON schema.
- `server/world.ts`: types, map, seed characters. State persists to `world.json` (delete it to reset).
- `public/`: canvas map, speech bubbles, news feed, force-directed relationship graph, character panel.
