export const SUPPORTED_OPENAI_MODELS = [
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
] as const;

export type SupportedOpenAiModel = (typeof SUPPORTED_OPENAI_MODELS)[number];

const supportedModelIds = new Set<string>(SUPPORTED_OPENAI_MODELS);

export function resolveRequestedOpenAiModel(
  requestedModel: string | null | undefined,
  fallbackModel: string,
): string {
  if (requestedModel === null || requestedModel === undefined) {
    return fallbackModel;
  }

  const normalized = requestedModel.trim();
  if (!normalized) {
    throw new Error("模型不能为空。");
  }
  if (!supportedModelIds.has(normalized)) {
    throw new Error(
      `不支持的模型:${normalized}。可选模型:${SUPPORTED_OPENAI_MODELS.join(", ")}。`,
    );
  }
  return normalized;
}
