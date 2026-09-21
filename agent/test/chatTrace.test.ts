import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RequestStore } from '../src/chat/requestStore.js';
import { ChatTraceRecorder } from '../src/chat/chatTrace.js';

test('trace journal survives re-opening, omits internal IDs and tolerates an interrupted final append', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-trace-'));
  try {
    const store = new RequestStore(directory);
    const trace = new ChatTraceRecorder(store, 'request');
    await trace.record({ type: 'thread.started', sessionId: 'private-session', threadId: 'private-thread' });
    await Promise.all([
      trace.record({ type: 'message.delta', sessionId: 'private-session', itemId: 'answer', delta: 'ha', text: 'ha' }),
      trace.record({ type: 'message.delta', sessionId: 'private-session', itemId: 'answer', delta: 'ha', text: 'haha' }),
    ]);
    await trace.record({ type: 'message.delta', sessionId: 'private-session', itemId: 'answer', delta: 'new', text: 'new' });
    await trace.record({ type: 'run.completed', sessionId: 'private-session', result: {
      sessionId: 'private-session', threadId: 'private-thread', finalResponse: 'new', provider: 'nexttoken',
      model: 'gpt-5.6-terra', knowledgeSources: [], summary: null,
    }, usage: null });
    const events = await new RequestStore(directory).readTrace('request');
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.slice(0, 3).map(event => event.delta), ['ha', 'ha', 'new']);
    assert.equal(events[2]?.replaceText, true);
    assert.doesNotMatch(JSON.stringify(events), /private-session|private-thread|sessionId|threadId|"text"/);
    assert.equal(events[3]?.result, undefined);
    const filename = path.join(directory, 'request.trace.jsonl');
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await appendFile(filename, '{"partial":');
    assert.deepEqual(await store.readTrace('request'), events);
    assert.deepEqual(await store.readTrace('legacy-without-trace'), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
