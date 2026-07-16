export const SUPPORTED_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

const supportedModelIds = new Set<string>(SUPPORTED_MODELS);

export function resolveRequestedModel(
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
      `不支持的模型:${normalized}。可选模型:${SUPPORTED_MODELS.join(", ")}。`,
    );
  }
  return normalized;
}
