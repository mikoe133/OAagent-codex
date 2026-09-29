export type AttachmentIntent = 'analyze' | 'upload' | 'both' | 'clarify' | 'ignore';
export type AttachmentMode = 'auto' | 'analyze' | 'upload';
export type AttachmentDecision = {
  intent: AttachmentIntent;
  requiresVision: boolean;
  visionModel: 'moonshotai/kimi-k3' | 'qwen/qwen3.8-max-0902';
  reason: string;
};
export type AttachmentRoutingInput = {
  files: { id: string; name: string; mime: string; size: number }[];
  source: 'current' | 'previous';
  mode: AttachmentMode;
  target?: string;
  selectedModel: { provider: string; model: string; supportsImages: boolean };
};
export const ATTACHMENT_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'requiresVision', 'visionModel', 'reason'],
  properties: {
    intent: { type: 'string', enum: ['analyze', 'upload', 'both', 'clarify', 'ignore'] },
    requiresVision: { type: 'boolean' },
    visionModel: { type: 'string', enum: ['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902'] },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;
export function unavailableAttachmentDecision(): AttachmentDecision {
  return { intent: 'clarify', requiresVision: false, visionModel: 'moonshotai/kimi-k3', reason: '附件语义路由暂不可用，请明确需求后重试。' };
}
// Validate the model's structured decision, never infer intent from keywords.
export function decodeAttachmentDecision(value: unknown, input: AttachmentRoutingInput): AttachmentDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid attachment route');
  const item = value as Record<string, unknown>;
  if (typeof item.intent !== 'string' || !['analyze', 'upload', 'both', 'clarify', 'ignore'].includes(item.intent) ||
      typeof item.requiresVision !== 'boolean' ||
      typeof item.visionModel !== 'string' || !['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902'].includes(item.visionModel) ||
      typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 200) throw new Error('invalid attachment route');
  if (item.requiresVision && (!['analyze', 'both'].includes(String(item.intent)) || !input.files.some(file => file.mime.startsWith('image/')))) {
    throw new Error('invalid attachment vision route');
  }
  return { intent: item.intent as AttachmentIntent, requiresVision: item.requiresVision, visionModel: item.visionModel as AttachmentDecision['visionModel'], reason: item.reason.trim() };
}
