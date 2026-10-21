import { ChatError } from './chatScheduler.js';

export const MODEL_CREDITS_MESSAGE = '模型服务账户余额不足（402），请充值后重试，或切换模型提供商。';

export class ModelCreditsError extends ChatError {
  constructor() { super(402, 'model_credits_exhausted', MODEL_CREDITS_MESSAGE); }
}

export function isModelCreditsFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b402\b|insufficient[ _-]credits/i.test(message);
}

// Public errors are fixed messages; arbitrary upstream details never reach chat history.
export function publicChatFailureMessage(code: string): string {
  return code === 'model_credits_exhausted' ? MODEL_CREDITS_MESSAGE : code;
}
