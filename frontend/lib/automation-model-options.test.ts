import assert from "node:assert/strict"
import test from "node:test"

import type { AutomationModelCatalog } from "./automation-api"
import {
  getAutomationModelOptions,
  getAutomationProviderOptions,
  resolveAutomationModelSelection,
} from "./automation-model-options"

const catalog: AutomationModelCatalog = {
  catalog_version: "catalog-v2",
  providers: [
    {
      provider: "nexttoken",
      display_name: "NextToken",
      models: [
        {
          model_id: "gpt-current",
          display_name: "GPT Current",
          enabled: true,
          is_default: true,
        },
        {
          model_id: "gpt-retired",
          display_name: "GPT Retired",
          enabled: false,
        },
      ],
    },
  ],
}

test("keeps a removed provider visible while editing a historical task", () => {
  assert.deepEqual(getAutomationProviderOptions(catalog, "legacy-provider"), [
    { value: "nexttoken", label: "NextToken", available: true },
    {
      value: "legacy-provider",
      label: "legacy-provider（当前不可用）",
      available: false,
    },
  ])
})

test("keeps a disabled historical model next to the available models", () => {
  assert.deepEqual(getAutomationModelOptions(catalog, "nexttoken", "gpt-retired"), [
    {
      value: "gpt-current",
      label: "GPT Current",
      available: true,
      isDefault: true,
    },
    {
      value: "gpt-retired",
      label: "GPT Retired（当前不可用）",
      available: false,
      isDefault: undefined,
    },
  ])
})

test("keeps a removed model visible without duplicating an available current model", () => {
  const removed = getAutomationModelOptions(catalog, "nexttoken", "gpt-removed")
  const available = getAutomationModelOptions(catalog, "nexttoken", "gpt-current")

  assert.equal(removed.at(-1)?.label, "gpt-removed（当前不可用）")
  assert.equal(removed.at(-1)?.available, false)
  assert.equal(available.filter((option) => option.value === "gpt-current").length, 1)
})

test("preserves a historical task model selection exactly", () => {
  assert.deepEqual(
    resolveAutomationModelSelection(catalog, "nexttoken", "gpt-retired"),
    { provider: "nexttoken", modelId: "gpt-retired" },
  )
})

test("recovers a provider from a historical model when the provider field is missing", () => {
  assert.deepEqual(
    resolveAutomationModelSelection(catalog, "", "gpt-retired"),
    { provider: "nexttoken", modelId: "gpt-retired" },
  )
})

test("fills a missing model from the selected provider default", () => {
  assert.deepEqual(
    resolveAutomationModelSelection(catalog, "nexttoken", ""),
    { provider: "nexttoken", modelId: "gpt-current" },
  )
})

test("uses the first available default when both task model fields are missing", () => {
  assert.deepEqual(
    resolveAutomationModelSelection(catalog),
    { provider: "nexttoken", modelId: "gpt-current" },
  )
})
