import type { LLMConfig } from "./llm.ts";

// Node-only: build the LLM config from environment variables (server mode).
// Kept out of llm.ts so the shared module never touches process.env and can
// run inside a browser bundle.
export function configFromEnv(): LLMConfig {
  const provider = process.env.MIIU_PROVIDER === "openai" ? "openai" : "ollama";
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("MIIU_PROVIDER=openai but OPENAI_API_KEY is not set (put it in .env)");
  }
  return {
    provider,
    ollamaUrl: process.env.OLLAMA_URL,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    model: process.env.MIIU_MODEL,
    openaiReasoning: process.env.MIIU_OPENAI_REASONING,
  };
}
