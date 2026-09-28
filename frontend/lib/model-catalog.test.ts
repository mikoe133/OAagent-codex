import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"

import {
  DEFAULT_ROUTER_MODELS,
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  ROUTER_MODELS,
  getDefaultModel,
  getModelsForProvider,
  isModelForProvider,
  isModelProvider,
  isRouterModel,
  isRouterModelSelection,
  readStoredRouterModels,
  toggleRouterModel,
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

test("exposes the dedicated lightweight router model choices", () => {
  assert.deepEqual(DEFAULT_ROUTER_MODELS, ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"])
  assert.deepEqual(
    ROUTER_MODELS.map((model) => model.id),
    [
      "z-ai/glm-4.7-flash",
      "qwen/qwen3.5-flash-02-23",
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4.1-flash",
      "qwen/qwen3.8-flash",
    ],
  )
  assert.equal(isRouterModel("qwen/qwen3.5-flash-02-23"), true)
  assert.equal(isRouterModel("z-ai/glm-5.3"), false)
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
      "deepseek/deepseek-v4-flash",
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
    icon: "/images/deepseek-color.png",
  })
  assert.equal(existsSync(new URL("../public/images/deepseek-color.png", import.meta.url)), true)
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


test("restores multi-selection and migrates missing, invalid or legacy storage to the new default pair", () => {
  for (const stored of [null, "invalid", "z-ai/glm-4.7-flash", '"z-ai/glm-4.7-flash"', "[]", '["unknown"]']) {
    assert.deepEqual(readStoredRouterModels(stored), DEFAULT_ROUTER_MODELS)
  }
  assert.deepEqual(readStoredRouterModels('["qwen/qwen3.8-flash","qwen/qwen3.8-flash"]'), ["qwen/qwen3.8-flash"])
  assert.equal(isRouterModelSelection(null), false)
  assert.equal(isRouterModelSelection([]), false)
  assert.equal(isRouterModelSelection(["qwen/qwen3.8-flash", "unknown"]), false)
})

test("allows adding and removing every router while retaining at least one", () => {
  const next = toggleRouterModel(DEFAULT_ROUTER_MODELS, "qwen/qwen3.8-flash")
  assert.deepEqual(next, [...DEFAULT_ROUTER_MODELS, "qwen/qwen3.8-flash"])
  assert.deepEqual(toggleRouterModel(next, "z-ai/glm-5.3-flash"), ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"])
  assert.deepEqual(toggleRouterModel(["qwen/qwen3.8-flash"], "qwen/qwen3.8-flash"), ["qwen/qwen3.8-flash"])
  assert.deepEqual(DEFAULT_ROUTER_MODELS, ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"])
})
