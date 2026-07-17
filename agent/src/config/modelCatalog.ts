export const MODEL_PROVIDER_IDS = ["nexttoken", "openrouter"] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export const MODEL_CATALOG = {
  nexttoken: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  openrouter: [
    "z-ai/glm-5.2",
    "moonshotai/kimi-k3",
    "openai/gpt-5.5",
    "openai/gpt-5.4",
  ],
} as const satisfies Record<ModelProviderId, readonly string[]>;

const DEFAULT_MODELS = {
  nexttoken: "gpt-5.6-terra",
  openrouter: "z-ai/glm-5.2",
} as const satisfies Record<ModelProviderId, string>;

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === "string" && MODEL_PROVIDER_IDS.includes(value as ModelProviderId);
}

export function getDefaultModel(provider: ModelProviderId): string {
  return DEFAULT_MODELS[provider];
}

export function resolveRequestedProvider(
  requestedProvider: string | null | undefined,
  fallbackProvider: ModelProviderId,
): ModelProviderId {
  if (requestedProvider === null || requestedProvider === undefined) {
    return fallbackProvider;
  }

  const normalized = requestedProvider.trim();
  if (!isModelProviderId(normalized)) {
    throw new Error(
      `不支持的模型提供商:${normalized || "空"}。可选提供商:${MODEL_PROVIDER_IDS.join(", ")}。`,
    );
  }
  return normalized;
}

export function resolveRequestedModel(
  provider: ModelProviderId,
  requestedModel: string | null | undefined,
  fallbackModel: string,
): string {
  const normalized = (requestedModel ?? fallbackModel).trim();
  if (!normalized) {
    throw new Error("模型不能为空。");
  }
  if (!MODEL_CATALOG[provider].some((model) => model === normalized)) {
    throw new Error(
      `提供商 ${provider} 不支持模型:${normalized}。可选模型:${MODEL_CATALOG[provider].join(", ")}。`,
    );
  }
  return normalized;
}
