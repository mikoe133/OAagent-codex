import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"

import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  getDefaultModel,
  getModelsForProvider,
  isModelForProvider,
  isModelProvider,
} from "./model-catalog"

test("defaults to OpenRouter while exposing both provider choices", () => {
  assert.equal(DEFAULT_MODEL_PROVIDER, "openrouter")
  assert.equal(getDefaultModel(DEFAULT_MODEL_PROVIDER), "z-ai/glm-5.2")
  assert.deepEqual(
    MODEL_PROVIDERS.map((provider) => provider.id),
    ["nexttoken", "openrouter"],
  )
  assert.equal(isModelProvider("nexttoken"), true)
  assert.equal(isModelProvider("openrouter"), true)
  assert.equal(isModelProvider("unknown"), false)
})

test("keeps provider model lists isolated", () => {
  assert.equal(getDefaultModel("nexttoken"), "gpt-5.6-terra")
  assert.equal(getDefaultModel("openrouter"), "z-ai/glm-5.2")
  assert.deepEqual(
    getModelsForProvider("openrouter").map((model) => model.id),
    [
      "z-ai/glm-5.2",
      "moonshotai/kimi-k3",
      "openai/gpt-5.5",
      "openai/gpt-5.4",
    ],
  )
  assert.equal(isModelForProvider("openrouter", "z-ai/glm-5.2"), true)
  assert.equal(isModelForProvider("openrouter", "moonshotai/kimi-k3"), true)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.4-mini"), false)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.4-nano"), false)
  assert.equal(isModelForProvider("nexttoken", "z-ai/glm-5.2"), false)
})

test("labels Kimi K3 in the OpenRouter model list", () => {
  const kimiModel = getModelsForProvider("openrouter").find(
    (model) => model.id === "moonshotai/kimi-k3",
  )

  assert.equal(kimiModel?.name, "Kimi K3")
})

test("uses the official Z.ai icon for GLM-5.2", () => {
  const glmModel = getModelsForProvider("openrouter").find((model) => model.id === "z-ai/glm-5.2")

  assert.equal(glmModel?.icon, "/images/z-ai.svg")
})

test("uses a local Moonshot AI icon for Kimi K3", () => {
  const kimiModel = getModelsForProvider("openrouter").find(
    (model) => model.id === "moonshotai/kimi-k3",
  )

  assert.equal(kimiModel?.icon, "/images/moonshot-ai.svg")
  assert.equal(existsSync(new URL("../public/images/moonshot-ai.svg", import.meta.url)), true)
})

test("ships the official Z.ai icon as a local frontend asset", () => {
  assert.equal(existsSync(new URL("../public/images/z-ai.svg", import.meta.url)), true)
})
