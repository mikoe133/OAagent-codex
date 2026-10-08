import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { AgentService, type SendMessageInput } from '../src/application/agentService.js';
import { createAgentHttpServer } from '../src/api/httpServer.js';
import { createChatConfirmation, confirmationToolToken, confirmationResponseSchema } from '../src/chat/confirmation.js';
import { ChatError } from '../src/chat/chatScheduler.js';
import type { AppConfig } from '../src/config/config.js';
import { beginOaTurn, finishOaTurn } from '../src/infrastructure/oa/oaQueryPolicy.js';
import { SessionStore, type AgentSession } from '../src/infrastructure/persistence/sessionStore.js';
import { authorizeAdminWrite, prepareOaChatAccess } from '../src/infrastructure/oa/oaChatAccess.js';

const plan = { title: '创建目录并上传附件', description: '在测试知识库根目录创建文件夹并上传本轮附件。', actions: ['创建文件夹', '上传附件'] };
const expired = (error: unknown) => error instanceof ChatError && error.status === 409 && error.code === 'confirmation_expired';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chat-confirmation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  const store = new SessionStore(file);
  await store.bindOaToken('session-a', 'oa-token', 'owner-a', '51');
  return { file, store };
}

test('confirmation survives restart, revalidates identity and is consumed once', async t => {
  const { file, store } = await fixture(t);
  const confirmation = createChatConfirmation(plan);
  await store.setConfirmation('session-a', confirmation);
  const restarted = new SessionStore(file);
  assert.deepEqual((await restarted.getOrCreate('session-a')).pendingConfirmation, confirmation);
  await assert.rejects(restarted.respondToConfirmation('session-a', { id: confirmation.id, decision: 'approve' }), expired);
  await restarted.bindOaToken('session-a', 'fresh-oa-token', 'owner-a', '51');
  assert.deepEqual(await restarted.respondToConfirmation('session-a', { id: confirmation.id, decision: 'approve' }), { confirmation, decision: 'approve' });
  assert.equal((await restarted.getOrCreate('session-a')).pendingConfirmation, undefined);
  await assert.rejects(restarted.respondToConfirmation('session-a', { id: confirmation.id, decision: 'approve' }), expired);
  const persisted = await readFile(file, 'utf8');
  assert.doesNotMatch(persisted, /oa-token|confirmationDecision|pendingConfirmation/);
});

test('rejects another session, changed account, replaced plan and expired plan', async t => {
  const { store } = await fixture(t);
  const first = createChatConfirmation(plan);
  await store.setConfirmation('session-a', first);
  await store.bindOaToken('session-b', 'other-token', 'owner-b', '52');
  await assert.rejects(store.respondToConfirmation('session-b', { id: first.id, decision: 'approve' }), expired);
  await store.bindOaToken('session-a', 'other-token', undefined, '52');
  await assert.rejects(store.respondToConfirmation('session-a', { id: first.id, decision: 'approve' }), expired);
  await store.bindOaToken('session-a', 'oa-token', undefined, '51');
  const second = createChatConfirmation(plan);
  await store.setConfirmation('session-a', second);
  await assert.rejects(store.respondToConfirmation('session-a', { id: first.id, decision: 'approve' }), expired);
  await store.setConfirmation('session-a', { ...second, expiresAt: new Date(Date.now() - 1).toISOString() });
  await assert.rejects(store.respondToConfirmation('session-a', { id: second.id, decision: 'approve' }), expired);
});

test('two simultaneous clicks consume a confirmation only once', async t => {
  const { store } = await fixture(t);
  const confirmation = createChatConfirmation(plan);
  await store.setConfirmation('session-a', confirmation);
  const response = { id: confirmation.id, decision: 'approve' as const };
  const results = await Promise.allSettled([store.respondToConfirmation('session-a', response), store.respondToConfirmation('session-a', response)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && expired(rejected.reason));
});

test('session preparation carries only verified decisions and clears superseded plans', async t => {
  const { file, store } = await fixture(t);
  const service = new AgentService({} as AppConfig, store) as unknown as { prepareSession(input: SendMessageInput): Promise<AgentSession> };
  for (const decision of ['approve', 'decline'] as const) {
    const confirmation = createChatConfirmation(plan);
    await store.setConfirmation('session-a', confirmation);
    const session = await service.prepareSession({ sessionId: 'session-a', message: '确认或取消', oaApiToken: 'oa-token', oaUserId: '51', confirmationResponse: { id: confirmation.id, decision } });
    assert.deepEqual(session.confirmationDecision, { confirmation, decision });
    assert.equal((await store.getOrCreate('session-a')).confirmationDecision, undefined);
    assert.doesNotMatch(await readFile(file, 'utf8'), /confirmationDecision/);
  }
  const old = createChatConfirmation(plan);
  await store.setConfirmation('session-a', old);
  const session = await service.prepareSession({ sessionId: 'session-a', message: '改为查询资料' });
  assert.equal(session.pendingConfirmation, undefined);
  assert.equal(session.confirmationDecision, undefined);
  await assert.rejects(store.respondToConfirmation('session-a', { id: old.id, decision: 'approve' }), expired);
});

test('internal confirmation tool requires the active session capability and validates its plan', async t => {
  const { store } = await fixture(t);
  const config = { oaApiToolToken: 'tool-secret' } as AppConfig;
  const server = createAgentHttpServer(config, {} as AgentService, store);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { finishOaTurn('session-a'); server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/__internal/request-chat-confirmation`;
  const token = confirmationToolToken(config.oaApiToolToken, 'session-a');
  const request = (authorization: string, confirmation: unknown = plan) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a', confirmation }) });
  assert.equal((await request(token)).status, 401);
  beginOaTurn('session-a', { mode: 'multi_step', exactPersonName: null });
  assert.equal((await request(confirmationToolToken(config.oaApiToolToken, 'session-b'))).status, 401);
  assert.equal((await request(config.oaApiToolToken)).status, 401);
  assert.equal((await request(token, { ...plan, actions: [] })).status, 400);
  assert.equal((await request(token, { ...plan, id: 'forged' })).status, 400);
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, ['scripts/requestConfirmation.mjs', '--input', JSON.stringify(plan)], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH, CALL_CHAT_CONFIRMATION_URL: url, CALL_CHAT_CONFIRMATION_TOKEN: token, CALL_OA_API_SESSION_ID: 'session-a' },
    timeout: 10_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.deepEqual((await store.getOrCreate('session-a')).pendingConfirmation, result.confirmation);
  assert.doesNotMatch(stdout, /tool-secret|oa-token/);
});

test('confirmation schemas reject invalid, empty or excessive user input', () => {
  for (const input of [{ ...plan, actions: [] }, { ...plan, actions: Array(11).fill('write') }, { ...plan, description: ' ' }]) assert.throws(() => createChatConfirmation(input));
  for (const response of [{ id: 'not-a-uuid', decision: 'approve' }, { id: createChatConfirmation(plan).id, decision: 'execute' }, { id: createChatConfirmation(plan).id, decision: 'approve', sessionId: 'other' }]) assert.equal(confirmationResponseSchema.safeParse(response).success, false);
});

test('click approval preserves the administrator request check while cancellation grants no write', async t => {
  const { store } = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 200, success: true, data: [] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const config = { oaApiBaseUrl: 'https://oa.test', oaApiTokenHeader: 'Authorization', oaApiTokenPrefix: 'Bearer' } as AppConfig;
  const service = new AgentService(config, store) as unknown as { prepareSession(input: SendMessageInput): Promise<AgentSession> };
  const request = { operationId: 'admin_update', body: { userId: 51, value: 'test' } };
  for (const decision of ['approve', 'decline'] as const) {
    await prepareOaChatAccess(config, 'session-a', 'oa-token', '准备操作');
    const pending = authorizeAdminWrite('session-a', 'oa-token', request);
    assert.equal(pending.allowed, false);
    if (pending.allowed) assert.fail('expected a confirmation challenge');
    const confirmation = createChatConfirmation({ ...plan, confirmationReply: pending.confirmationReply });
    await store.setConfirmation('session-a', confirmation);
    await service.prepareSession({ sessionId: 'session-a', message: '卡片点击', confirmationResponse: { id: confirmation.id, decision } });
    assert.equal(authorizeAdminWrite('session-a', 'oa-token', request).allowed, decision === 'approve');
    assert.equal(authorizeAdminWrite('session-a', 'oa-token', { ...request, body: { ...request.body, value: 'changed' } }).allowed, false);
  }
});
