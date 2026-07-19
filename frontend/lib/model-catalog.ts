export const MODEL_PROVIDERS = [
  { id: "nexttoken", name: "Nexttoken" },
  { id: "openrouter", name: "OpenRouter" },
] as const

export type ModelProvider = (typeof MODEL_PROVIDERS)[number]["id"]

export type ModelOption = {
  id: string
  name: string
  icon: string
}

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
    { id: "z-ai/glm-5.2", name: "GLM-5.2", icon: "/images/z-ai.svg" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3", icon: "/images/moonshot-ai.svg" },
    { id: "openai/gpt-5.5", name: "GPT-5.5", icon: "/images/gpt.png" },
    { id: "openai/gpt-5.4", name: "GPT-5.4", icon: "/images/gpt.png" },
  ],
} as const satisfies Record<ModelProvider, readonly ModelOption[]>

export type AIModel =
  | (typeof MODELS_BY_PROVIDER.nexttoken)[number]["id"]
  | (typeof MODELS_BY_PROVIDER.openrouter)[number]["id"]

export const DEFAULT_MODEL_PROVIDER: ModelProvider = "openrouter"

const DEFAULT_MODELS = {
  nexttoken: "gpt-5.6-terra",
  openrouter: "z-ai/glm-5.2",
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
