import type { AgentStreamEvent } from '../application/agentService.js';
import type { RequestStore } from './requestStore.js';

export type ChatTraceEvent = Record<string, unknown> & {
  type: string;
  sequence: number;
  occurredAt: string;
};

// Only persist the public, already-redacted event payload. Never persist internal
// session/thread identifiers or the complete run result (which contains both).
const fields = ['itemId', 'toolType', 'name', 'input', 'status', 'outputDelta',
  'result', 'error', 'durationMs', 'message', 'detail', 'delta', 'text', 'exitCode'] as const;

export class ChatTraceRecorder {
  private sequence = 0;
  private pending = Promise.resolve();
  private messageTexts = new Map<string, string>();
  constructor(private store: RequestStore, private key: string) {}

  record(event: AgentStreamEvent | { type: 'run.queued' | 'run.completed' | 'run.failed'; status?: string; error?: string }) {
    if (event.type === 'thread.started') return Promise.resolve();
    const entry: ChatTraceEvent = {
      type: event.type, sequence: ++this.sequence, occurredAt: new Date().toISOString(),
    };
    const source = event as unknown as Record<string, unknown>;
    for (const field of fields) {
      if (source[field] !== undefined && !(event.type === 'run.completed' && field === 'result')) {
        entry[field] = source[field];
      }
    }
    // Keep the journal linear in message size instead of repeating the complete
    // cumulative text on every token. Preserve explicit text replacements too.
    if (event.type === 'message.delta') {
      const previous = this.messageTexts.get(event.itemId) ?? '';
      entry.delta = event.text.startsWith(previous) ? event.text.slice(previous.length) : event.text;
      if (!event.text.startsWith(previous)) entry.replaceText = true;
      delete entry.text;
      this.messageTexts.set(event.itemId, event.text);
    }
    this.pending = this.pending.then(() => this.store.appendTrace(this.key, entry));
    return this.pending;
  }
}
