import type { ChatStreamEvent } from './chat-stream'

// A browser stream can fail after the server has committed its result. Recover
// only that same request; never submit a new business operation to check it.
export function completedRequestEvent(value: unknown, recordId: string, requestId: string): ChatStreamEvent | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (request.recordId !== recordId || request.requestId !== requestId || request.state !== 'completed' || !request.result || typeof request.result !== 'object') return null
  const result = request.result as Record<string, unknown>
  if (typeof result.finalResponse !== 'string') return null
  return { type: 'run.completed', result: { ...result, traceEvents: request.traceEvents } }
}
