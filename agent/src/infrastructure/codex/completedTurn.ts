import type { Thread, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';

// turn.completed is the protocol boundary. Do not wait for CLI telemetry/exit
// after a terminal answer; returning closes the SDK iterator and its child.
export async function* completedTurnEvents(events: AsyncGenerator<ThreadEvent>): AsyncGenerator<ThreadEvent> {
  const active = new Set<string>();
  let terminalAnswer = false;
  for await (const event of events) {
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(item.type)) {
        terminalAnswer = false;
        if (event.type === 'item.completed') active.delete(item.id);
        else active.add(item.id);
      }
      if (item.type === 'agent_message' && event.type === 'item.completed') terminalAnswer = Boolean(item.text.trim());
    }
    yield event;
    if (event.type === 'turn.completed' && terminalAnswer && active.size === 0) return;
  }
}

export async function runCompletedTurn(thread: Thread, input: Parameters<Thread['run']>[0]) {
  const { events } = await thread.runStreamed(input);
  const items: ThreadItem[] = [];
  let finalResponse = '';
  let usage: Usage | null = null;
  for await (const event of completedTurnEvents(events)) {
    if (event.type === 'item.completed') {
      items.push(event.item);
      if (event.item.type === 'agent_message') finalResponse = event.item.text;
    }
    if (event.type === 'turn.completed') usage = event.usage;
    if (event.type === 'turn.failed') throw new Error(event.error.message);
    if (event.type === 'error') throw new Error(event.message);
  }
  return { items, finalResponse, usage };
}
