// Active provider/model indicator (issue #27): pure label logic, no DOM access,
// so the mapping is unit-testable from node. The API key is never an input here.
import { DEFAULT_MODEL } from "../server/llm.ts";

export interface SetupSummary {
  provider: "ollama" | "openai";
  model?: string;
}

// Describes the actually-running configuration for the gear affordance and the
// setup modal. `ready` is whether the saved setup can start (OpenAI needs a key);
// web/app.ts passes its own readyToStart result so both stay in step.
export function describeSetup(setup: SetupSummary | null, ready: boolean): string {
  if (!setup || !ready) return "No model connected";
  const model = setup.model || DEFAULT_MODEL[setup.provider];
  return `${setup.provider === "openai" ? "OpenAI" : "Ollama"} (${model})`;
}
