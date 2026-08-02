import assert from "node:assert/strict"
import test from "node:test"

import type { AutomationModelCatalog } from "./automation-api"
import {
  getAutomationModelOptions,
  getAutomationProviderOptions,
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
