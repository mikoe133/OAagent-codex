export const MODEL_PROVIDERS = [
  { id: "nexttoken", name: "Nexttoken" },
  { id: "openrouter", name: "OpenRouter" },
] as const

export type ModelProvider = (typeof MODEL_PROVIDERS)[number]["id"]

export type ModelOption = {
  id: string
  name: string
  icon: string
  disabled?: boolean
}

export const ROUTER_MODELS = [
  { id: "z-ai/glm-4.7-flash", name: "GLM 4.7 Flash" },
  { id: "qwen/qwen3.5-flash-02-23", name: "Qwen 3.5 Flash" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { id: "qwen/qwen3.8-flash", name: "Qwen 3.8 Flash" },
] as const

export type RouterModel = (typeof ROUTER_MODELS)[number]["id"]

export const DEFAULT_ROUTER_MODELS = [
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
] as const satisfies readonly RouterModel[]

export const MODELS_BY_PROVIDER = {
  nexttoken: [
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", icon: "/images/gpt.png" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", icon: "/images/gpt.png" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", icon: "/images/gpt.png" },
    { id: "gpt-5.5", name: "GPT-5.5", icon: "/images/gpt.png" },
    { id: "gpt-5.4", name: "GPT-5.4", icon: "/images/gpt.png" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", icon: "/images/gpt.png" },
  ],
  openrouter: [
    { id: "z-ai/glm-5.3", name: "GLM-5.3", icon: "/images/z-ai.svg" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3", icon: "/images/moonshot-ai.svg" },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      icon: "/images/deepseek-color.png",
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      icon: "/images/deepseek-color.png",
    },
    { id: "openai/gpt-5.6", name: "GPT-5.6", icon: "/images/gpt.png", disabled: true },
  ],
} as const satisfies Record<ModelProvider, readonly ModelOption[]>

export type AIModel =
  | (typeof MODELS_BY_PROVIDER.nexttoken)[number]["id"]
  | (typeof MODELS_BY_PROVIDER.openrouter)[number]["id"]

export const DEFAULT_MODEL_PROVIDER: ModelProvider = "openrouter"

const DEFAULT_MODELS = {
  nexttoken: "gpt-5.6-terra",
  openrouter: "z-ai/glm-5.3",
} as const satisfies Record<ModelProvider, AIModel>

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && MODEL_PROVIDERS.some((provider) => provider.id === value)
}

export function getModelsForProvider(
  provider: ModelProvider,
): (typeof MODELS_BY_PROVIDER)[ModelProvider] {
  return MODELS_BY_PROVIDER[provider]
}

export function getDefaultModel(provider: ModelProvider): AIModel {
  return DEFAULT_MODELS[provider]
}

export function isModelForProvider(provider: ModelProvider, value: unknown): value is AIModel {
  return typeof value === "string" && getModelsForProvider(provider).some((model) => model.id === value)
}

export function isAIModel(value: unknown): value is AIModel {
  return isModelForProvider("nexttoken", value) || isModelForProvider("openrouter", value)
}

export function isRouterModel(value: unknown): value is RouterModel {
  return typeof value === "string" && ROUTER_MODELS.some((model) => model.id === value)
}

export function isRouterModelSelection(value: unknown): value is RouterModel[] {
  return Array.isArray(value) && value.length > 0 && value.length <= ROUTER_MODELS.length && value.every(isRouterModel)
}

export function readStoredRouterModels(value: string | null): RouterModel[] {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null
    if (isRouterModelSelection(parsed)) return [...new Set(parsed)]
  } catch { /* Invalid or legacy values use the new defaults. */ }
  return [...DEFAULT_ROUTER_MODELS]
}

export function toggleRouterModel(models: readonly RouterModel[], model: RouterModel): RouterModel[] {
  if (!models.includes(model)) return [...models, model]
  return models.length > 1 ? models.filter(selected => selected !== model) : [...models]
}
