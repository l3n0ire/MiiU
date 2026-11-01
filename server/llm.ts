import { MOODS, REL_LABELS, type Character, type Mood, type Relationship, type RelLabel } from "./world.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const MODEL = process.env.MIIU_MODEL ?? "gemma4-pi";

export type Line = { speaker: string; text: string };

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

function cleanOutcome(o: Outcome, names: string[]): Outcome {
  return {
    outcomes: (o.outcomes ?? [])
      .filter((x) => names.includes(x.name))
      .map((x) => ({ ...x, mood: MOODS.includes(x.mood) ? x.mood : "neutral" })),
    pairs: (o.pairs ?? [])
      .filter((p) => names.includes(p.a) && names.includes(p.b) && p.a !== p.b)
      .map((p) => ({
        ...p,
        affinity_delta: Math.max(-15, Math.min(15, Math.round(Number(p.affinity_delta) || 0))),
        relationship: REL_LABELS.includes(p.relationship) ? p.relationship : "acquaintance",
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
): Promise<{ says: string; wants_to_leave: boolean }> {
  const otherNames = others.map((o) => o.name);
  const older = speaker.memories.slice(0, -5).filter((m) => otherNames.some((n) => m.includes(n)));
  const memories = [...older, ...speaker.memories.slice(-5)];
  const feelings = others
    .map((o) => {
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
${turnsLeft <= 2 ? "The conversation is winding down; wrap up naturally.\n" : ""}Set wants_to_leave to true if ${speaker.name} would end the conversation or walk away now.`;

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
  return cleanOutcome(await callJson<Outcome>(prompt, schema), names);
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

async function callJson<T>(prompt: string, schema: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0.9 },
        messages: [
          { role: "system", content: "You are the narrator of a cozy life-simulation game. Reply only with JSON matching the schema." },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message: { content: string } };
    try {
      return JSON.parse(body.message.content) as T;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
}
