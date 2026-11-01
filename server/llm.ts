import { MOODS, REL_LABELS, type Character, type Mood, type Relationship, type RelLabel } from "./world.ts";

// MIIU_PROVIDER=ollama (default, local) or openai (needs OPENAI_API_KEY).
const PROVIDER = process.env.MIIU_PROVIDER === "openai" ? "openai" : "ollama";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OPENAI_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_REASONING = process.env.MIIU_OPENAI_REASONING; // e.g. "minimal"/"low" for faster gpt-5 replies
export const MODEL = process.env.MIIU_MODEL ?? (PROVIDER === "openai" ? "gpt-5-mini" : "gemma4-pi");

if (PROVIDER === "openai" && !process.env.OPENAI_API_KEY) {
  throw new Error("MIIU_PROVIDER=openai but OPENAI_API_KEY is not set (put it in .env)");
}

export type Line = { speaker: string; text: string };

export const USER_ID = "__user__";

// A stand-in Character for the human player so they can appear in prompts and transcripts.
export function asUser(name = "You"): Character {
  return {
    id: USER_ID, name,
    personality: "The human player visiting the island",
    likes: "", dislikes: "", color: "#888888",
    pos: { x: 0, y: 0 }, target: { x: 0, y: 0 },
    state: "idle", idleUntil: 0, mood: "neutral", memories: [], bubble: null,
  };
}

export interface Outcome {
  outcomes: { name: string; memory: string; mood: Mood }[];
  pairs: { a: string; b: string; affinity_delta: number; relationship: RelLabel }[];
}

export interface PairInfo { a: Character; b: Character; rel: Relationship }

function describe(c: Character) {
  const mem = c.memories.length ? c.memories.slice(-5).map((m) => `  - ${m}`).join("\n") : "  (none yet)";
  return `${c.name}
  Personality: ${c.personality}
  Likes: ${c.likes || "?"} | Dislikes: ${c.dislikes || "?"}
  Current mood: ${c.mood}
  Recent memories:
${mem}`;
}

const transcript = (lines: Line[]) => lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");

function outcomeSchema(names: string[], pairs: PairInfo[]) {
  return {
    outcomes: {
      type: "array",
      minItems: names.length,
      maxItems: names.length,
      items: {
        type: "object",
        properties: { name: { type: "string", enum: names }, memory: { type: "string" }, mood: { type: "string", enum: MOODS } },
        required: ["name", "memory", "mood"],
      },
    },
    pairs: {
      type: "array",
      minItems: pairs.length,
      maxItems: pairs.length,
      items: {
        type: "object",
        properties: {
          a: { type: "string", enum: names },
          b: { type: "string", enum: names },
          affinity_delta: { type: "integer", minimum: -15, maximum: 15 },
          relationship: { type: "string", enum: REL_LABELS },
        },
        required: ["a", "b", "affinity_delta", "relationship"],
      },
    },
  };
}

function outcomeInstructions(names: string[], pairs: PairInfo[]) {
  return `- outcomes: for EACH of ${names.join(", ")}: a one-sentence first-person memory of this chat, and their mood afterwards
- pairs: for EACH pair (${pairs.map((p) => `${p.a.name}+${p.b.name}`).join(", ")}): affinity_delta (-15..15) for how this chat changed their feelings, and their relationship label afterwards`;
}

function cleanOutcome(o: Outcome, names: string[], pairs: PairInfo[]): Outcome {
  return {
    outcomes: (o.outcomes ?? [])
      .filter((x) => names.includes(x.name))
      .map((x) => ({ ...x, mood: MOODS.includes(x.mood) ? x.mood : "neutral" })),
    pairs: (o.pairs ?? [])
      .filter((p) => names.includes(p.a) && names.includes(p.b) && p.a !== p.b)
      .map((p) => ({
        ...p,
        affinity_delta: Math.max(-15, Math.min(15, Math.round(Number(p.affinity_delta) || 0))),
        // On invalid model output keep the pair's current label instead of resetting to acquaintance.
        relationship: REL_LABELS.includes(p.relationship)
          ? p.relationship
          : pairs.find((q) => (q.a.name === p.a && q.b.name === p.b) || (q.a.name === p.b && q.b.name === p.a))?.rel.label ?? "acquaintance",
      })),
  };
}

function relationsText(pairs: PairInfo[]) {
  return pairs
    .map(({ a, b, rel }) => {
      const past = rel.history.length ? ` Past: ${rel.history.slice(-2).join(" / ")}` : " They have never talked.";
      return `- ${a.name} & ${b.name}: "${rel.label}" (affinity ${rel.affinity} on -100..100).${past}`;
    })
    .join("\n");
}

// One call per line, from the speaker's point of view only.
// The speaker sees their own personality and memories, how they feel about the others,
// and the conversation so far — never the other characters' minds.
export async function generateLine(
  speaker: Character,
  others: Character[],
  pairs: PairInfo[],
  lines: Line[],
  place: string,
  turnsLeft: number,
  canLeave: boolean,
): Promise<{ says: string; wants_to_leave: boolean }> {
  const otherNames = others.map((o) => o.name);
  const older = speaker.memories.slice(0, -5).filter((m) => otherNames.some((n) => m.includes(n)));
  const memories = [...older, ...speaker.memories.slice(-5)];
  const feelings = others
    .map((o) => {
      if (o.id === USER_ID) return `- ${o.name}: the human player visiting the island - talk to them like a friendly neighbor`;
      const rel = pairs.find((p) => (p.a === speaker && p.b === o) || (p.b === speaker && p.a === o))?.rel;
      return !rel || (rel.label === "stranger" && !rel.history.length)
        ? `- ${o.name}: you don't really know them yet`
        : `- ${o.name}: you see them as "${rel.label}" (affinity ${rel.affinity} on -100..100)`;
    })
    .join("\n");

  const prompt = `You are ${speaker.name}, a resident of a tiny island in a cozy life-sim. Stay fully in character.

About you:
  Personality: ${speaker.personality}
  Likes: ${speaker.likes || "?"} | Dislikes: ${speaker.dislikes || "?"}
  Current mood: ${speaker.mood}

Your memories:
${memories.length ? memories.map((m) => `  - ${m}`).join("\n") : "  (none yet)"}

You are at ${place}, talking with:
${feelings}

Conversation so far:
${lines.length ? transcript(lines) : "(nobody has spoken yet — you start the conversation)"}

Write ONLY your next line as ${speaker.name} (max ~20 words). React to what was just said.
Do not repeat or paraphrase earlier lines. Do not write lines for anyone else.
${turnsLeft <= 2 ? "The conversation is winding down; wrap up naturally.\n" : ""}${
    canLeave
      ? `Set wants_to_leave to true if ${speaker.name} would end the conversation or walk away now.`
      : "The conversation just started: don't say goodbye yet, and set wants_to_leave to false."
  }`;

  const schema = {
    type: "object",
    properties: { says: { type: "string" }, wants_to_leave: { type: "boolean" } },
    required: ["says", "wants_to_leave"],
  };
  const out = await callJson<{ says: string; wants_to_leave: boolean }>(prompt, schema);
  let says = String(out.says ?? "").trim();
  const prefix = `${speaker.name.toLowerCase()}:`;
  if (says.toLowerCase().startsWith(prefix)) says = says.slice(prefix.length).trim();
  if (!says) throw new Error("empty line");
  return { says, wants_to_leave: Boolean(out.wants_to_leave) };
}

// After a conversation, one call reads the transcript and decides memories, moods and affinity.
export async function summarizeConversation(members: Character[], pairs: PairInfo[], lines: Line[], place: string): Promise<Outcome> {
  const names = members.map((c) => c.name);
  const schema = { type: "object", properties: outcomeSchema(names, pairs), required: ["outcomes", "pairs"] };
  const prompt = `This conversation just happened at ${place} on a tiny island.

${members.map(describe).join("\n\n")}

Relationships before the chat:
${relationsText(pairs)}

Transcript:
${transcript(lines)}

Decide:
${outcomeInstructions(names, pairs)}`;
  return cleanOutcome(await callJson<Outcome>(prompt, schema), names, pairs);
}

export interface Reaction { name: string; says: string; mood: Mood; memory: string }

export async function generateReactions(event: string, chars: Character[]): Promise<Reaction[]> {
  const names = chars.map((c) => c.name);
  const schema = {
    type: "object",
    properties: {
      reactions: {
        type: "array",
        minItems: chars.length,
        maxItems: chars.length,
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: names },
            says: { type: "string" },
            mood: { type: "string", enum: MOODS },
            memory: { type: "string" },
          },
          required: ["name", "says", "mood", "memory"],
        },
      },
    },
    required: ["reactions"],
  };
  const prompt = `Something just happened on the tiny island: "${event}"

How does each of these residents react?

${chars.map(describe).join("\n\n")}

For EACH resident (${names.join(", ")}) give:
- says: what they blurt out right now, in character (max ~15 words)
- mood: their mood afterwards
- memory: one first-person sentence they'll remember about this`;
  const { reactions } = await callJson<{ reactions: Reaction[] }>(prompt, schema);
  return reactions
    .filter((r) => names.includes(r.name))
    .map((r) => ({ ...r, mood: MOODS.includes(r.mood) ? r.mood : "neutral" }));
}

const SYSTEM = "You are the narrator of a cozy life-simulation game. Reply only with JSON matching the schema.";

export interface IslandEvent { headline: string; target: string; gather: string }

// Invent a spontaneous island event that riffs on recent conversations.
// target is a resident name or "everyone"; gather is a landmark name or "nowhere".
export async function generateEvent(
  recentChats: { place: string; lines: Line[] }[],
  chars: Character[],
  landmarks: string[],
): Promise<IslandEvent> {
  const names = chars.map((c) => c.name);
  const schema = {
    type: "object",
    properties: {
      headline: { type: "string" },
      target: { type: "string", enum: [...names, "everyone"] },
      gather: { type: "string", enum: [...landmarks, "nowhere"] },
    },
    required: ["headline", "target", "gather"],
  };
  const history = recentChats
    .map((ch) => `At ${ch.place}:\n${ch.lines.slice(-8).map((l) => `${l.speaker}: ${l.text}`).join("\n")}`)
    .join("\n\n");
  const residents = chars
    .map((c) => `- ${c.name} (${c.mood})${c.memories.length ? `: last memory "${c.memories[c.memories.length - 1]}"` : ""}`)
    .join("\n");
  const prompt = `On a tiny island, these conversations just happened:

${history}

Residents right now:
${residents}

Invent ONE surprising, chaotic island event that riffs on what the residents have actually been talking about or feeling. It must connect to the conversations above, not be random noise.

Decide:
- headline: one short punchy news headline for the event (max 12 words, no names needed unless it helps)
- target: who it primarily happens to - one resident name, or "everyone"
- gather: a landmark where residents gather for it, or "nowhere"`;
  const ev = await callJson<IslandEvent>(prompt, schema);
  return {
    headline: String(ev.headline ?? "").slice(0, 120),
    target: names.includes(ev.target) ? ev.target : "everyone",
    gather: landmarks.includes(ev.gather) ? ev.gather : "nowhere",
  };
}

async function callJson<T>(prompt: string, schema: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const content = PROVIDER === "openai" ? await callOpenAI(prompt, schema) : await callOllama(prompt, schema);
    try {
      return JSON.parse(content) as T;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
}

async function callOllama(prompt: string, schema: object): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0.9 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message: { content: string } };
  return body.message.content;
}

async function callOpenAI(prompt: string, schema: object): Promise<string> {
  const res = await fetch(`${OPENAI_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      ...(OPENAI_REASONING && { reasoning_effort: OPENAI_REASONING }),
      response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: toStrictSchema(schema) } },
      messages: [
        { role: "system", content: SYSTEM },
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
  if (!msg?.content) throw new Error(`OpenAI returned no content${msg?.refusal ? `: ${msg.refusal}` : ""}`);
  return msg.content;
}

// OpenAI strict mode needs additionalProperties:false and every property required on each object,
// and rejects some numeric/array bounds. Our clean* helpers re-apply those bounds after parsing.
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
