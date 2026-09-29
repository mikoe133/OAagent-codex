import type { AgentProgressEvent } from '../application/agentService.js';
import type { AttachmentDecision } from './attachmentIntent.js';
import { applyAttachmentDecision } from './attachmentContext.js';
import { attachmentExecutionModel } from './attachmentModel.js';

export function applyAttachmentRoute(sessionId: string, provider: string, model: string, decision: AttachmentDecision, failed = false) {
  applyAttachmentDecision(sessionId, decision);
  const execution = attachmentExecutionModel(provider, model, decision);
  const events: AgentProgressEvent[] = [{
    type: 'progress', sessionId, itemId: 'attachment-intent-routing', toolType: 'attachment_route',
    status: failed ? 'failed' : 'completed', message: decision.reason,
    detail: { intent: decision.intent, requiresVision: decision.requiresVision },
  }];
  if (execution.switched) {
    const name = execution.model === 'moonshotai/kimi-k3' ? 'Kimi K3' : 'Qwen 3.8 Max';
    events.push({
      type: 'progress', sessionId, itemId: 'attachment-model-routing', toolType: 'model_switch', status: 'completed',
      message: `切换为 ${name} 模型用作文件解析（仅本次请求）`,
      detail: { requested: { provider, model }, effective: { provider: execution.provider, model: execution.model } },
    });
  }
  return { ...execution, events };
}
