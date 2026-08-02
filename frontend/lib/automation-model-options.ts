import type { AutomationModelCatalog } from "./automation-api"

export type AutomationModelSelectOption = {
  value: string
  label: string
  available: boolean
  isDefault?: boolean
}

export function getAutomationProviderOptions(
  catalog: AutomationModelCatalog | null | undefined,
  currentProvider: string,
): AutomationModelSelectOption[] {
  const options = (catalog?.providers ?? []).map((provider) => ({
    value: provider.provider,
    label: provider.display_name,
    available: true,
  }))

  if (currentProvider && !options.some((option) => option.value === currentProvider)) {
    options.push({
      value: currentProvider,
      label: unavailableLabel(currentProvider),
      available: false,
    })
  }

  return options
}

export function getAutomationModelOptions(
  catalog: AutomationModelCatalog | null | undefined,
  currentProvider: string,
  currentModel: string,
): AutomationModelSelectOption[] {
  const provider = catalog?.providers.find((item) => item.provider === currentProvider)
  const options = (provider?.models ?? [])
    .filter((model) => model.enabled)
    .map((model) => ({
      value: model.model_id,
      label: model.display_name,
      available: true,
      isDefault: model.is_default,
    }))

  if (currentModel && !options.some((option) => option.value === currentModel)) {
    const historicalModel = provider?.models.find((model) => model.model_id === currentModel)
    options.push({
      value: currentModel,
      label: unavailableLabel(historicalModel?.display_name ?? currentModel),
      available: false,
      isDefault: historicalModel?.is_default,
    })
  }

  return options
}

function unavailableLabel(label: string): string {
  return `${label}（当前不可用）`
}
