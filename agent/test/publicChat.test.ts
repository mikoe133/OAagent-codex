import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentHttpServer } from '../src/api/httpServer.js';
import { SessionStore } from '../src/infrastructure/persistence/sessionStore.js';
import { ChatScheduler } from '../src/chat/chatScheduler.js';
import { ChatLatencyMetricsRecorder } from '../src/infrastructure/observability/chatLatency.js';
import type { AgentService } from '../src/application/agentService.js';
import type { AppConfig } from '../src/config/config.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('OA IDs, persistent idempotency, result/history queries, disconnection, failed sync and ownership', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'public-chat-'));
  const originalFetch = globalThis.fetch;
  const config = { sessionStorePath: path.join(dir, 'sessions.json'), oaApiBaseUrl: 'https://oa.test', oaAuthAlias: 'default', oaUserTokenHeader: 'Authorization', oaUserTokenPrefix: 'Bearer', modelProvider: 'nexttoken', model: 'gpt-5.6-terra' } as AppConfig;
  const records = new Map<string, any>(); let nextId = 1, calls = 0, failSave = false;
  const entered = deferred(), release = deferred(), cancelEntered = deferred();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get('authorization');
    const user = token === 'Bearer other' ? 2 : 1;
    if (url.pathname === '/user/user') return Response.json({ success: true, data: { user_id: user, email: `${user}@test.com` } });
    if (url.pathname === '/copilot/list') return Response.json({ data: { items: [...records.values()].filter(r => r.user_id === user), total: records.size } });
    const id = url.searchParams.get('record_id')!;
    if (init?.method === 'POST') {
      const record = { id: nextId++, user_id: user, record: JSON.parse(String(init.body)), created_at: 1720000000, updated_at: 1720000000 };
      records.set(String(record.id), record); return Response.json({ data: record });
    }
    if (!records.has(id)) return Response.json({}, { status: 404 });
    if (init?.method === 'PATCH') {
      if (failSave) return Response.json({}, { status: 503 });
      records.get(id).record = JSON.parse(String(init.body));
    }
    if (init?.method === 'DELETE') { records.delete(id); return Response.json({ data: { record_id: id } }); }
    return Response.json({ data: records.get(id) });
  };
  const service = { async streamMessage(input: any, emit: any, signal: AbortSignal) {
    calls++;
    assert.match(input.sessionId, /^oa-/);
    await emit({ type: 'progress', sessionId: input.sessionId, itemId: 'route', toolType: 'semantic_route', status: 'completed', message: '路由完成', durationMs: 12 });
    await emit({ type: 'tool.started', sessionId: input.sessionId, itemId: 'lookup', toolType: 'command_execution', name: 'node scripts/callOaApi.mjs --operationId list_reports' });
    if (input.message === 'wait') { entered.resolve(); await release.promise; }
    if (input.message === 'fail') throw new Error('private secret');
    if (input.message === 'cancel') {
      cancelEntered.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    signal.throwIfAborted();
    await emit({ type: 'tool.completed', sessionId: input.sessionId, itemId: 'lookup', toolType: 'command_execution', name: 'node scripts/callOaApi.mjs --operationId list_reports', status: 'completed', outputDelta: 'saved output', durationMs: 34 });
    await emit({ type: 'thread.started', sessionId: input.sessionId, threadId: 'private-thread' });
    await emit({ type: 'message.delta', sessionId: input.sessionId, itemId: 'm', delta: 'answer', text: 'answer' });
    await emit({ type: 'run.completed', sessionId: input.sessionId, result: { finalResponse: 'answer', provider: input.provider, model: input.model, knowledgeSources: [], threadId: 'private-thread', sessionId: input.sessionId }, usage: null });
  } } as AgentService;
  const servers: ReturnType<typeof createAgentHttpServer>[] = [];
  async function start() {
    const server = createAgentHttpServer(config, service, new SessionStore(config.sessionStorePath), undefined, new ChatLatencyMetricsRecorder({ logger: () => {} })); servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}`;
  }
  const base = await start();
  const request = (suffix: string, method = 'GET', body?: unknown, key?: string, token = 'valid', origin = base) => originalFetch(`${origin}/v1/sessions${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const created = await request('', 'POST', {}); assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), '/v1/sessions/1');
    assert.equal((await created.json()).recordId, '1');
    assert.equal((await request('', 'POST', { sessionId: 'custom' })).status, 400);
    assert.equal((await request('/legacy/messages', 'POST', { message: 'x' }, 'k')).status, 404);
    assert.equal((await request('/1/messages', 'POST', { message: 'x' })).status, 400);
    const stream = await request('/1/messages/stream', 'POST', { message: 'wait' }, 'first');
    const reader = stream.body!.getReader(); await reader.read(); await reader.cancel();
    await entered.promise;
    const running = await (await request('/1/requests/first')).json();
    assert.equal(running.state, 'running');
    assert.ok(running.traceEvents.some((event: any) => event.type === 'tool.started'));
    assert.equal((await request('/1/messages', 'POST', { message: 'wait' }, 'first')).status, 409);
    const restarted = await start();
    assert.equal((await (await request('/1/requests/first', 'GET', undefined, undefined, 'valid', restarted)).json()).state, 'unknown');
    assert.equal((await request('/1/messages', 'POST', { message: 'wait' }, 'first', 'valid', restarted)).status, 409);
    assert.equal(calls, 1);
    release.resolve();
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await (await request('/1/requests/first')).json();
      if (state.historySync === 'synced') break;
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(state.state, 'completed'); assert.equal(state.historySync, 'synced');
    assert.equal(state.result.finalResponse, 'answer'); assert.equal('fingerprint' in state, false);
    assert.ok(state.traceEvents.some((event: any) => event.outputDelta === 'saved output'));
    const restored = await (await request('/1/requests/first', 'GET', undefined, undefined, 'valid', restarted)).json();
    assert.deepEqual(restored.traceEvents, state.traceEvents);
    assert.deepEqual(records.get('1').record.messages[1].traceEvents, state.traceEvents);
    assert.equal(records.get('1').record.messages[1].model, 'gpt-5.6-terra');
    assert.equal(records.get('1').record.messages[1].provider, 'nexttoken');
    const replay = await request('/1/messages/stream', 'POST', { message: 'wait' }, 'first', 'valid', restarted);
    const text = await replay.text(); assert.match(text, /run.completed/); assert.doesNotMatch(text, /threadId|sessionId|private-thread/);
    assert.match(text, /saved output/);
    assert.equal(calls, 1);
    assert.equal((await request('/1/messages', 'POST', { message: 'changed' }, 'first')).status, 409);
    assert.equal((await request('/1/requests/first', 'GET', undefined, undefined, 'other')).status, 404);
    const page = await (await request('/1/messages?limit=1')).json(); assert.equal(page.messages.length, 1); assert.equal(page.nextCursor, '1');
    assert.equal((await (await request('/1/messages?limit=1&cursor=1')).json()).messages[0].role, 'assistant');
    failSave = true;
    const unsynced = await (await request('/1/messages', 'POST', { message: 'second' }, 'second')).json();
    assert.equal(unsynced.state, 'completed'); assert.equal(unsynced.historySync, 'pending'); assert.equal(calls, 2);
    failSave = false;
    assert.equal((await request('/1/requests/second/sync', 'POST')).status, 200);
    assert.ok(records.get('1').record.messages[3].traceEvents.length > 0);
    assert.equal((await request('/1/requests/second/sync', 'POST')).status, 200);
    assert.equal(calls, 2); assert.equal(records.get('1').record.messages.length, 4);
    assert.equal((await request('/1', 'PATCH', { messages: [] })).status, 400);
    assert.equal((await request('/1', 'PATCH', { title: 'renamed' })).status, 200);
    assert.equal(records.get('1').record.messages.length, 4);
    const failed = await request('/1/messages', 'POST', { message: 'fail' }, 'failed');
    assert.equal(failed.status, 409); assert.doesNotMatch(await failed.text(), /private secret/);
    const failedHistory = records.get('1').record.messages.find((message: any) => message.id === 'failed:assistant');
    assert.equal(failedHistory.status, 'failed');
    assert.ok(failedHistory.traceEvents.some((event: any) => event.type === 'tool.started'));
    assert.equal(failedHistory.traceEvents.at(-1).type, 'run.failed');
    assert.equal((await request('/1/messages', 'POST', { message: 'fail' }, 'failed')).status, 409); assert.equal(calls, 3);
    const cancellationStream = await request('/1/messages/stream', 'POST', { message: 'cancel' }, 'cancel');
    await cancelEntered.promise;
    assert.equal((await request('/1', 'DELETE')).status, 409);
    assert.equal((await request('/1/requests/cancel/cancel', 'POST')).status, 202);
    assert.match(await cancellationStream.text(), /run.failed/);
    assert.equal((await (await request('/1/requests/cancel')).json()).state, 'cancelled');
    const cancelledHistory = records.get('1').record.messages.find((message: any) => message.id === 'cancel:assistant');
    assert.equal(cancelledHistory.status, 'stopped');
    assert.equal(cancelledHistory.traceEvents.at(-1).status, 'cancelled');
    assert.equal((await request('/1/messages', 'POST', { message: 'cancel' }, 'cancel')).status, 409);
    assert.equal(calls, 4);
    assert.equal((await request('/1/messages', 'POST', { message: 'x'.repeat(140000) }, 'large')).status, 413);
    assert.equal((await request('/1', 'DELETE')).status, 200);
    assert.equal((await request('/1/requests/first')).status, 404);
  } finally {
    release.resolve();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true });
  }
});

test('scheduler bounds active work, preserves session order, fairly admits other users and cancels queued work', async () => {
  const scheduler = new ChatScheduler({ concurrency: 2, userConcurrency: 1, queue: 2, userQueue: 1, perMinute: 10, queueMs: 500, executionMs: 1000 });
  const gate = deferred(); const order: string[] = [];
  const first = scheduler.submit('a', 'a1', async () => { order.push('first'); await gate.promise; });
  await new Promise(r => setTimeout(r, 0));
  const queued = scheduler.submit('a', 'a1', async () => { order.push('queued'); });
  assert.throws(() => scheduler.submit('a', 'a2', async () => {}), /用户等待队列/);
  const other = scheduler.submit('b', 'b1', async () => { order.push('other'); });
  await other.done; assert.deepEqual(order, ['first', 'other']);
  const rejected = assert.rejects(queued.done, /取消/); queued.cancel(); await rejected;
  gate.resolve(); await first.done;
  assert.deepEqual(order, ['first', 'other']);
});

test('timeouts keep actual execution slots occupied and queue/rate failures do not start work', async () => {
  const scheduler = new ChatScheduler({ concurrency: 1, userConcurrency: 1, queue: 1, userQueue: 1, perMinute: 2, queueMs: 10, executionMs: 5 });
  const gate = deferred(); let aborted = false, secondRan = false;
  const first = scheduler.submit('a', 's', async signal => { signal.addEventListener('abort', () => { aborted = true; }); await gate.promise; });
  await new Promise(r => setTimeout(r, 0));
  const second = scheduler.submit('b', 't', async () => { secondRan = true; });
  assert.throws(() => scheduler.submit('c', 'u', async () => {}), /服务等待队列/);
  await assert.rejects(second.done, /排队超时/);
  assert.equal(aborted, true); assert.equal(secondRan, false); assert.equal(scheduler.busy('s'), true);
  gate.resolve(); await first.done;
});


test('burst submissions cannot oversubscribe admission and per-user rate limits persist after completion', async () => {
  const gate = deferred();
  const scheduler = new ChatScheduler({ concurrency: 1, userConcurrency: 1, queue: 1, userQueue: 1, perMinute: 1, queueMs: 1000, executionMs: 1000 });
  const first = scheduler.submit('a', '1', async () => gate.promise);
  const second = scheduler.submit('b', '2', async () => {});
  assert.throws(() => scheduler.submit('c', '3', async () => {}), /服务等待队列/);
  assert.throws(() => scheduler.submit('a', '4', async () => {}), /过于频繁/);
  gate.resolve(); await first.done; await second.done;
  assert.throws(() => scheduler.submit('a', '5', async () => {}), /过于频繁/);
});
