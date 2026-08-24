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
  assert.equal(getDefaultModel(DEFAULT_MODEL_PROVIDER), "z-ai/glm-5.3")
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
  assert.equal(getDefaultModel("openrouter"), "z-ai/glm-5.3")
  assert.deepEqual(
    getModelsForProvider("openrouter").map((model) => model.id),
    [
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.6",
    ],
  )
  assert.equal(isModelForProvider("openrouter", "z-ai/glm-5.3"), true)
  assert.equal(isModelForProvider("openrouter", "z-ai/glm-5.2"), false)
  assert.equal(isModelForProvider("openrouter", "moonshotai/kimi-k3"), true)
  assert.equal(isModelForProvider("openrouter", "deepseek/deepseek-v4-pro"), true)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.5"), false)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.4"), false)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.4-mini"), false)
  assert.equal(isModelForProvider("openrouter", "openai/gpt-5.4-nano"), false)
  assert.equal(isModelForProvider("nexttoken", "z-ai/glm-5.3"), false)
})

test("marks OpenRouter GPT-5.6 as temporarily unavailable", () => {
  const gptModel = getModelsForProvider("openrouter").find(
    (model) => model.id === "openai/gpt-5.6",
  )

  assert.deepEqual(gptModel, {
    id: "openai/gpt-5.6",
    name: "GPT-5.6",
    icon: "/images/gpt.png",
    disabled: true,
  })
})

test("labels Kimi K3 in the OpenRouter model list", () => {
  const kimiModel = getModelsForProvider("openrouter").find(
    (model) => model.id === "moonshotai/kimi-k3",
  )

  assert.equal(kimiModel?.name, "Kimi K3")
})

test("labels DeepSeek V4 Pro in the OpenRouter model list", () => {
  const deepSeekModel = getModelsForProvider("openrouter").find(
    (model) => model.id === "deepseek/deepseek-v4-pro",
  )

  assert.deepEqual(deepSeekModel, {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    icon: "/images/deepseek.svg",
  })
  assert.equal(existsSync(new URL("../public/images/deepseek.svg", import.meta.url)), true)
})

test("uses the official Z.ai icon for GLM-5.3", () => {
  const glmModel = getModelsForProvider("openrouter").find((model) => model.id === "z-ai/glm-5.3")

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
