import type { AttachmentDecision } from './attachmentIntent.js';

export const ATTACHMENT_ANALYSIS_MODELS = new Set(['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902']);
export function attachmentExecutionModel(provider: string, model: string, decision: AttachmentDecision) {
  const switched = decision.requiresVision && (decision.intent === 'analyze' || decision.intent === 'both') &&
    !(provider === 'openrouter' && ATTACHMENT_ANALYSIS_MODELS.has(model));
  return switched
    ? { provider: 'openrouter', model: decision.visionModel, switched }
    : { provider, model, switched: false };
}
