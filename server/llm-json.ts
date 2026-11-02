import { DEFAULT_MODEL, type LLMConfig } from "./llm.ts";

// Generic structured-JSON caller over the same two providers as llm.ts
// (Ollama chat with a JSON schema format, OpenAI chat/completions with strict
// json_schema). llm.ts keeps the island-conversation prompts; this module is
// for other callers (like the bridge-puzzle crew planner) that need their own
// prompts and schemas over the same connection settings. Nothing here reads
// process.env, so it also runs inside a browser bundle.
export interface JsonCaller {
  provider: LLMConfig["provider"];
  model: string;
  callJson<T>(prompt: string, schema: object, opts?: { system?: string; temperature?: number }): Promise<T>;
}

export function createJsonCaller(config: LLMConfig): JsonCaller {
  const PROVIDER = config.provider;
  const OLLAMA_URL = (config.ollamaUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const OPENAI_URL = (config.openaiBaseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const MODEL = config.model ?? DEFAULT_MODEL[PROVIDER];

  if (PROVIDER === "openai" && !config.openaiApiKey) {
    throw new Error("provider is openai but no API key was provided");
  }

  async function callJson<T>(prompt: string, schema: object, opts: { system?: string; temperature?: number } = {}): Promise<T> {
    const system = opts.system ?? "Reply only with JSON matching the schema.";
    for (let attempt = 0; ; attempt++) {
      const content = PROVIDER === "openai" ? await callOpenAI(prompt, schema, system) : await callOllama(prompt, schema, system, opts.temperature);
      try {
        return JSON.parse(content) as T;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
  }

  async function callOllama(prompt: string, schema: object, system: string, temperature?: number): Promise<string> {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: schema,
        options: { temperature: temperature ?? 0.7 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message: { content: string } };
    return body.message.content;
  }

  async function callOpenAI(prompt: string, schema: object, system: string): Promise<string> {
    const res = await fetch(`${OPENAI_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify({
        model: MODEL,
        ...(config.openaiReasoning && { reasoning_effort: config.openaiReasoning }),
        response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: toStrictSchema(schema) } },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err.slice(0, 300)}`);
    }
    const body = (await res.json()) as { choices: { message: { content: string | null; refusal?: string } }[] };
    const msg = body.choices[0]?.message;
    if (!msg?.content) throw new Error(`OpenAI returned no content${msg.refusal ? `: ${msg.refusal}` : ""}`);
    return msg.content;
  }

  return { provider: PROVIDER, model: MODEL, callJson };
}

// Same OpenAI strict-mode transform as llm.ts: additionalProperties:false and
// every property required on each object; no numeric/array bounds.
function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (["minItems", "maxItems", "minimum", "maximum"].includes(k)) continue;
    out[k] = k === "enum" ? v : toStrictSchema(v);
  }
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}
