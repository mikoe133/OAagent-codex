import { createHash } from "node:crypto";

export const MODEL_PROVIDER_IDS = ["nexttoken", "openrouter"] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export const MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export type AutomationModelParameters = {
  reasoning_effort?: ModelReasoningEffort;
  max_output_tokens?: number;
};

export type AutomationModelSelection = {
  modelProvider: ModelProviderId;
  modelId: string;
  modelParameters: AutomationModelParameters;
};

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

export const MODEL_CATALOG_VERSION = `sha256:${createHash("sha256")
  .update(JSON.stringify(MODEL_CATALOG))
  .digest("hex")
  .slice(0, 24)}`;

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

export function getModelDisplayName(model: string): string {
  const modelName = model.split("/").at(-1) ?? model;
  return modelName
    .split("-")
    .map((part) => part.toLowerCase() === "gpt" ? "GPT" : capitalize(part))
    .join(" ");
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

export function resolveAutomationModelSelection(
  requested: {
    modelProvider?: string | null;
    modelId?: string | null;
    modelParameters?: unknown;
  },
  fallback: {
    modelProvider: ModelProviderId;
    modelId: string;
    modelParameters?: AutomationModelParameters;
  },
): AutomationModelSelection {
  const modelProvider = resolveRequestedProvider(
    requested.modelProvider,
    fallback.modelProvider,
  );
  const fallbackModel = modelProvider === fallback.modelProvider
    ? fallback.modelId
    : getDefaultModel(modelProvider);
  return {
    modelProvider,
    modelId: resolveRequestedModel(modelProvider, requested.modelId, fallbackModel),
    modelParameters: requested.modelParameters === undefined
      ? { ...(fallback.modelParameters ?? {}) }
      : decodeAutomationModelParameters(requested.modelParameters),
  };
}

export function decodeAutomationModelParameters(
  value: unknown,
): AutomationModelParameters {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("model_parameters 必须是 JSON object。");
  }
  const unknownFields = Object.keys(value).filter(
    (field) => field !== "reasoning_effort" && field !== "max_output_tokens",
  );
  if (unknownFields.length > 0) {
    throw new Error(`model_parameters 包含不支持的字段:${unknownFields.join(", ")}。`);
  }

  const parameters: AutomationModelParameters = {};
  if (value.reasoning_effort !== undefined) {
    if (
      typeof value.reasoning_effort !== "string" ||
      !MODEL_REASONING_EFFORTS.includes(
        value.reasoning_effort as ModelReasoningEffort,
      )
    ) {
      throw new Error(
        `reasoning_effort 必须是 ${MODEL_REASONING_EFFORTS.join(", ")} 之一。`,
      );
    }
    parameters.reasoning_effort = value.reasoning_effort as ModelReasoningEffort;
  }
  if (value.max_output_tokens !== undefined) {
    if (
      !Number.isInteger(value.max_output_tokens) ||
      (value.max_output_tokens as number) < 256 ||
      (value.max_output_tokens as number) > 4_096
    ) {
      throw new Error("max_output_tokens 必须是 256-4096 的整数。");
    }
    parameters.max_output_tokens = value.max_output_tokens as number;
  }
  return parameters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
