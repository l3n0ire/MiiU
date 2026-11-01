import { test } from "node:test";
import assert from "node:assert/strict";
import { createLLM, asUser } from "./llm.ts";
import { newCharacter } from "./world.ts";

// Captures the prompt generateLine sends and replies with a canned line.
function stubFetch(capture: { prompt?: string }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    const messages = JSON.parse(String(init?.body)).messages as { content: string }[];
    capture.prompt = messages.map((m) => m.content).join("\n");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ says: "Ahoy!", wants_to_leave: false }) } }], usage: {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

const pip = () => newCharacter({ name: "Pip", personality: "cheerful", likes: "", dislikes: "", color: "#888888" });

test("full context: keeps the first four priority entries, drops the fifth", async () => {
  const capture: { prompt?: string } = {};
  const restore = stubFetch(capture);
  try {
    const llm = createLLM({ provider: "openai", openaiApiKey: "dummy", model: "test-model" });
    const activity = ["player bond line", "island news", "chat one", "chat two", "oldest chat dropped"];
    await llm.generateLine(pip(), [asUser("Sam")], [], [], "Park", 99, false, activity);
    const p = capture.prompt!;
    for (const kept of activity.slice(0, 4)) assert.ok(p.includes(kept), `prompt should include "${kept}"`);
    assert.ok(!p.includes("oldest chat dropped"), "the lowest-priority entry must be dropped when full");
  } finally { restore(); }
});

test("short activity renders fully; empty shows (nothing yet)", async () => {
  const capture: { prompt?: string } = {};
  const restore = stubFetch(capture);
  try {
    const llm = createLLM({ provider: "openai", openaiApiKey: "dummy", model: "test-model" });
    await llm.generateLine(pip(), [asUser("Sam")], [], [], "Park", 99, false, ["only entry"]);
    assert.ok(capture.prompt!.includes("only entry"));
    await llm.generateLine(pip(), [asUser("Sam")], [], [], "Park", 99, false);
    assert.ok(capture.prompt!.includes("(nothing yet)"));
  } finally { restore(); }
});
