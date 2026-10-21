import type { ChatStreamEvent } from './chat-stream'
import { serverResponseDurationMs } from '@/lib/response-duration'

// A browser stream can fail after the server has committed its result. Recover
// only that same request; never submit a new business operation to check it.
export function completedRequestEvent(value: unknown, recordId: string, requestId: string): ChatStreamEvent | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Record<string, unknown>
  if (request.recordId !== recordId || request.requestId !== requestId || request.state !== 'completed' || !request.result || typeof request.result !== 'object') return null
  const result = request.result as Record<string, unknown>
  if (typeof result.finalResponse !== 'string') return null
  const durationMs = serverResponseDurationMs(request)
  return { type: 'run.completed', result: { ...result,
    ...(durationMs !== undefined ? { durationMs } : {}), traceEvents: request.traceEvents } }
}

/** Cancellation can be acknowledged before its terminal snapshot is committed. */
export async function loadTerminalRequestEvent(
  readStatus: () => Promise<unknown>,
  recordId: string,
  requestId: string,
  { maxAttempts = 8, retryDelayMs = 250 }: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<ChatStreamEvent | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = await readStatus()
    if (!value || typeof value !== 'object') return null
    const request = value as Record<string, unknown>
    if (request.recordId !== recordId || request.requestId !== requestId) return null
    if (request.state === 'completed') return completedRequestEvent(request, recordId, requestId)
    if (request.state === 'failed' || request.state === 'cancelled') {
      return { type: 'run.failed', state: request.state, error: request.errorMessage ?? request.errorCode,
        durationMs: serverResponseDurationMs(request), traceEvents: request.traceEvents }
    }
    if (request.state !== 'queued' && request.state !== 'running') return null
    if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
  return null
}
