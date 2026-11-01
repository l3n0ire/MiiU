import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSetup } from "./setup-label.ts";

test("first visit, nothing saved: not connected", () => {
  assert.equal(describeSetup(null, false), "No model connected");
});

test("OpenAI with remembered key shows provider and default model", () => {
  assert.equal(describeSetup({ provider: "openai" }, true), "OpenAI (gpt-6-luna)");
});

test("OpenAI with a custom model shows that model", () => {
  assert.equal(describeSetup({ provider: "openai", model: "gpt-6-sol" }, true), "OpenAI (gpt-6-sol)");
});

test("saved OpenAI setup without a usable key is not connected", () => {
  assert.equal(describeSetup({ provider: "openai" }, false), "No model connected");
  assert.equal(describeSetup({ provider: "openai", model: "gpt-6-sol" }, false), "No model connected");
});

test("Ollama shows provider and default model", () => {
  assert.equal(describeSetup({ provider: "ollama" }, true), "Ollama (gemma4-pi)");
});

test("Ollama with a custom model shows that model", () => {
  assert.equal(describeSetup({ provider: "ollama", model: "llama3.2" }, true), "Ollama (llama3.2)");
});

test("label is built only from provider and model; no key material appears", () => {
  const label = describeSetup({ provider: "openai", model: "sk-should-not-leak" }, true);
  assert.equal(label, "OpenAI (sk-should-not-leak)"); // model string only; keys are never inputs
  assert.ok(!describeSetup({ provider: "openai" }, true).includes("sk-"));
});
