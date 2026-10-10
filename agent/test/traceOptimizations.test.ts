import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { Codex, type ThreadEvent } from '@openai/codex-sdk';
import { completedTurnEvents, runCompletedTurn } from '../src/infrastructure/codex/completedTurn.js';
import { toolBusinessError, toolWaitingForConfirmation } from '../src/application/toolBusinessError.js';
import { buildOpenApiIndex } from '../src/infrastructure/oa/openApiIndex.js';

const answer: ThreadEvent = { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'answer' } };
const done: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };

test('terminal protocol event closes iterator without consuming process-exit tail', async () => {
  let closed = false;
  async function* events(): AsyncGenerator<ThreadEvent> {
    try { yield answer; yield done; assert.fail('must not wait for process-exit tail'); }
    finally { closed = true; }
  }
  const result = [];
  for await (const event of completedTurnEvents(events())) result.push(event);
  assert.deepEqual(result, [answer, done]); assert.equal(closed, true);
});

test('intermediate text and unfinished tools cannot trigger early completion', async () => {
  const command: ThreadEvent = { type: 'item.started', item: { id: 't', type: 'command_execution', command: 'x', aggregated_output: '', status: 'in_progress' } };
  let tailRead = false;
  async function* events(): AsyncGenerator<ThreadEvent> { yield answer; yield command; yield done; tailRead = true; }
  for await (const _event of completedTurnEvents(events())) { /* consume */ }
  assert.equal(tailRead, true);
  const failure: ThreadEvent = { type: 'turn.failed', error: { message: 'failed' } };
  async function* failed(): AsyncGenerator<ThreadEvent> { yield answer; yield failure; }
  const result = [];
  for await (const event of completedTurnEvents(failed())) result.push(event);
  assert.equal(result.at(-1), failure);
});

test('actual SDK stops its child after completed turn instead of waiting ten seconds', { timeout: 2500 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fixture.mjs');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\nfor (const event of ${JSON.stringify([{ type: 'thread.started', thread_id: 'fixture' }, answer, done])}) console.log(JSON.stringify(event));\nsetTimeout(() => process.exit(0), 10000);\n});\n`, { mode: 0o700 });
  const thread = new Codex({ codexPathOverride: executable }).startThread({ skipGitRepoCheck: true });
  const started = performance.now();
  const result = await runCompletedTurn(thread, 'synthetic');
  assert.equal(result.finalResponse, 'answer'); assert.equal(thread.id, 'fixture');
  assert.ok(performance.now() - started < 2000);
  t.diagnostic(`SDK fixture completed in ${Math.round(performance.now() - started)} ms; simulated process-exit delay was 10000 ms`);
});

test('controlled scripts preserve business error JSON and exit nonzero; successful retry exits zero', async t => {
  let ok = false;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok, ...(ok ? { data: 'done' } : { error: { message: 'bad input' } }) })); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, CALL_OA_READ_URL: url, CALL_OA_READ_TOKEN: 'fixture', CALL_OA_API_SESSION_ID: 'fixture', CALL_OA_API_URL: url, CALL_OA_API_TOKEN: 'fixture', CALL_KNOWLEDGE_BASE_API_URL: url, CALL_KNOWLEDGE_BASE_API_TOKEN: 'fixture' };
  for (const script of ['queryOaDatabase.mjs', 'callKnowledgeBaseApi.mjs', 'callOaApi.mjs']) {
    const execute = () => new Promise<{ code: number; stdout: string }>(resolve => execFile(process.execPath,
      [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), '--input', '{"action":"catalog"}', '--operationId', 'read'], { env }, (error, stdout) => resolve({ code: Number(error?.code ?? 0), stdout })));
    ok = false;
    const failed = await execute(); assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.stdout).ok, false);
    ok = true;
    const succeeded = await execute(); assert.equal(succeeded.code, 0); assert.equal(JSON.parse(succeeded.stdout).ok, true);
  }
});

test('waiting for confirmation is distinguishable from a business failure without claiming execution', () => {
  const command = 'node scripts/callOaApi.mjs --operationId write';
  const output = JSON.stringify({ ok: false, error: { code: 'confirmation_required', message: 'not executed' } });
  assert.equal(toolBusinessError(command, output), undefined);
  assert.equal(toolWaitingForConfirmation(command, output), true);
  assert.equal(toolWaitingForConfirmation('echo data', output), false);
  assert.equal(toolWaitingForConfirmation(command, JSON.stringify({ ok: true, rows: [{ error: { code: 'confirmation_required' } }] })), false);
});

test('controlled envelopes fail on business errors, not on arbitrary text or nested row fields', () => {
  const command = 'node scripts/callKnowledgeBaseApi.mjs --operationId read';
  assert.equal(toolBusinessError(command, JSON.stringify({ ok: false, status: 400, data: { error: { message: 'bad format' } } })), 'bad format');
  assert.equal(toolBusinessError(command, JSON.stringify({ ok: true, rows: [{ ok: false }] })), undefined);
  assert.equal(toolBusinessError('echo data', '{"ok":false}'), undefined);
  assert.equal(toolBusinessError(command, 'not JSON'), undefined);
});

test('candidate parameters retain enum/default so model does not guess accepted formats', () => {
  const index = buildOpenApiIndex({ paths: { '/page': { get: { operationId: 'read', parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['text', 'markdown'], default: 'markdown' } }] } } } });
  assert.deepEqual(index.operations[0]!.parameters[0], { name: 'format', in: 'query', required: false, type: 'string', enum: ['text', 'markdown'], default: 'markdown' });
});
