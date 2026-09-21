import {
  finalizeToolSteps, isToolTimelineEvent, mergeMessageTraceDelta, mergeToolTimelineEvent,
  type ChatStreamEvent, type ToolStep, type TraceMessage,
} from './chat-stream'

/** Reconstruct the same timeline as live SSE, using the server's durable journal. */
export function restoreStoredTrace(value: unknown, status: 'completed' | 'failed' | 'stopped' = 'completed') {
  if (!Array.isArray(value)) return undefined
  let toolSteps: ToolStep[] = []
  let traceMessages: TraceMessage[] = []
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') continue
    const event = entry as ChatStreamEvent & { replaceText?: boolean }
    if (typeof event.type === 'string' && isToolTimelineEvent(event.type)) {
      toolSteps = mergeToolTimelineEvent(toolSteps, {
        ...event, itemId: typeof event.itemId === 'string' ? event.itemId : `stored-progress-${index}`,
      })
    } else if (event.type === 'message.delta') {
      const previous = traceMessages.find(message => message.id === event.itemId)?.content ?? ''
      const delta = typeof event.delta === 'string' ? event.delta : ''
      // Use cumulative text for the UI merger so repeated chunks (e.g. "ha", "ha")
      // remain intact. The journal stores deltas to avoid quadratic disk growth.
      const text = typeof event.text === 'string' ? event.text : `${event.replaceText ? '' : previous}${delta}`
      traceMessages = mergeMessageTraceDelta(traceMessages, { ...event, text }, toolSteps.at(-1)?.id ?? null)
    }
  }
  return { toolSteps: finalizeToolSteps(toolSteps, status), traceMessages }
}
