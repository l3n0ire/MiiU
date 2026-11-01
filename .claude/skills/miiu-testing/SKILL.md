---
name: miiu-testing
description: How to run and test MiiU Island without a local LLM, and how to capture screenshot/video evidence for PRs. Use when changing server/sim.ts, server/llm.ts, server/world.ts or public/ behavior.
---

# MiiU testing without a model

`npm start` needs an LLM at `OLLAMA_URL` (default localhost:11434) or `MIIU_PROVIDER=openai`. For fast deterministic tests, point `OLLAMA_URL` at a schema-driven mock: the server sends the JSON schema in the request's `format` field, so a mock can generate conforming replies by walking the schema (arrays -> minItems items, integers -> clamped values, enums -> the label you want to exercise, strings -> canned text). Parse `format` from each request rather than pattern-matching prompts.

Useful env knobs while testing: `MIIU_MAX_CHATS=0` (no resident chats), `MIIU_AUTO_EVENTS=off`, `MIIU_SPAWNING=off`, `MIIU_PLAYER_SPAWNING=off`, `MIIU_SOCIAL_WANDER=off`, `MIIU_SPAWN_CHANCE=1` (deterministic spawn rolls), `PORT` to isolate.

## Driving the sim

Everything is one WebSocket: connect to `ws://localhost:PORT`, read `state` broadcasts, send `{type:"talk",a,b}` to force a pair chat, `{type:"chatStart",ids}`/`chatSend`/`chatEnd` for user chats, `{type:"speed",value:4}` to run 4x faster. `world.json` is the source of truth afterwards: relationships (incl. `timeline`), characters (incl. `occupation`), events. Delete `world.json` for a clean seed, or write one by hand to set up bonds/moods/positions for behavioral tests (measure distances between two miis over ~120 sim-seconds with a feature on vs off to show drift effects).

## PR evidence

Headless Chrome (or any CDP client) against the local server: sweep-click the map canvas until the resident panel shows what you need (pick radius is 0.8 tiles), screenshot the page for panel/feed/graph evidence, and stitch periodic screenshots with ffmpeg (`-framerate 5 -i frame-%04d.png -c:v libx264 -pix_fmt yuv420p`) for a short island clip. Attach both to the PR body. Mock-LLM runs must be labeled as mock in the PR; a real-model pass is separate evidence.
