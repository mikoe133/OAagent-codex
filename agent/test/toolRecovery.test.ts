import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadDatabase } from '../src/infrastructure/oa-read/database.js';
import { fetchWithReadRetry, withReadRetry } from '../src/infrastructure/tools/readRetry.js';
import {
  beginToolRecoveryTurn, finishToolRecoveryTurn, httpToolFailure,
  recoveryForError, runControlledTool, toolRequestFailure, withToolRecovery,
} from '../src/infrastructure/tools/toolRecovery.js';

test('safe read retries once with the remaining deadline, while writes and unknown errors do not retry', async () => {
  let time = 0;
  const budgets: number[] = [];
  const networkError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const result = await withReadRetry(async remainingMs => {
    budgets.push(remainingMs);
    if (budgets.length === 1) { time += 100; throw networkError; }
    return 'same query result';
  }, { readOnly: true, timeoutMs: 1000, now: () => time, sleep: async ms => { time += ms; } });
  assert.deepEqual(budgets, [1000, 800]);
  assert.deepEqual(result, { value: 'same query result', attempts: 2 });

  for (const [readOnly, error] of [[false, networkError], [true, new Error('bad parameters')]] as const) {
    let calls = 0;
    await assert.rejects(withReadRetry(async () => { calls++; throw error; }, {
      readOnly, timeoutMs: 1000, sleep: async () => { throw new Error('must not wait'); },
    }), caught => caught === error);
    assert.equal(calls, 1);
  }
});

test('spent budgets, long Retry-After and exhausted retries do not add another timeout', async () => {
  for (const scenario of ['deadline', 'retry-after', 'exhausted']) {
    let time = 0;
    let calls = 0;
    const waits: number[] = [];
    const result = await withReadRetry(async () => {
      calls++;
      if (scenario === 'deadline') time += 1000;
      return 503;
    }, {
      readOnly: true, timeoutMs: 1000, now: () => time,
      retryDelay: () => scenario === 'retry-after' ? 30_000 : 100,
      sleep: async ms => { waits.push(ms); time += ms; },
    });
    assert.equal(calls, scenario === 'exhausted' ? 2 : 1);
    assert.deepEqual(waits, scenario === 'exhausted' ? [100] : []);
    assert.equal(result.value, 503);
  }
});

test('HTTP reads retry transient failures only and keep body reads within the signal budget', async () => {
  for (const [status, readOnly, expectedCalls] of [[503, true, 2], [401, true, 1], [403, true, 1], [400, true, 1], [503, false, 1]] as const) {
    let calls = 0;
    const result = await fetchWithReadRetry(async (_url, init) => {
      calls++;
      assert.ok(init?.signal);
      return Response.json({ value: calls }, { status: calls === 1 ? status : 200 });
    }, new URL('https://fixture.test'), { method: readOnly ? 'GET' : 'POST' }, readOnly, 2000);
    assert.equal(calls, expectedCalls);
    assert.equal(result.attempts, expectedCalls);
    assert.equal(result.response.status, expectedCalls === 2 ? 200 : status);
  }
  let calls = 0;
  const bodyRecovered = await fetchWithReadRetry(async () => {
    calls++;
    if (calls === 1) return { text: async () => { throw Object.assign(new Error('body interrupted'), { code: 'ECONNRESET' }); } } as Response;
    return Response.json({ complete: true });
  }, new URL('https://fixture.test'), { method: 'GET' }, true, 2000);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(bodyRecovered.text), { complete: true });
});

test('failure recovery preserves precise instructions, confirmation and authentication are distinct states', () => {
  const invalid = withToolRecovery({ ok: false, error: {
    code: 'invalid_query', message: 'queries.0.from missing',
    recovery: { action: 'correct_parameters', instruction: 'Keep the period; fix queries.0.from.' },
  } });
  assert.equal(invalid.error.recovery.instruction, 'Keep the period; fix queries.0.from.');
  const paused = withToolRecovery({ ok: false, error: {
    code: 'metadata_sync_unavailable', message: 'paused',
    recovery: { action: 'stop_for_turn', retryAfterSeconds: 30, instruction: 'Do not poll catalog.' },
  } });
  assert.equal(paused.error.recovery.instruction, 'Do not poll catalog.');
  assert.equal(paused.error.recovery.retryAfterSeconds, 30);
  assert.equal(recoveryForError('confirmation_required').action, 'wait_for_confirmation');
  assert.equal(recoveryForError('upstream_request_failed', 401).action, 'authenticate');
  assert.equal(recoveryForError('upstream_request_failed', 403).category, 'permission');
  assert.equal(recoveryForError('metadata_version_changed').action, 'refresh_metadata');
  const limited = httpToolFailure(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  assert.equal(limited.error.recovery?.retryAfterSeconds, 60);
  assert.equal(limited.error.recovery?.action, 'stop_for_turn');
});

test('repeated unchanged failures are blocked within a turn, corrected inputs and successful reads stay available', async t => {
  const session = 'recovery-repeat-fixture';
  beginToolRecoveryTurn(session);
  t.after(() => finishToolRecoveryTurn(session));
  let calls = 0;
  const execute = async () => { calls++; return { ok: false, error: { code: 'invalid_query', message: 'missing from' } }; };
  const original = await runControlledTool('database', session, { version: 'v1', query: {} }, execute);
  assert.equal((original.error as any).recovery.action, 'correct_parameters');
  const repeated = await runControlledTool('database', session, { query: {}, version: 'v1' }, execute);
  assert.equal(calls, 1);
  assert.equal((repeated.error as any).recovery.action, 'stop_for_turn');
  assert.match((repeated.error as any).recovery.instruction, /已阻止重复执行/);
  const success = async () => { calls++; return { ok: true, rows: ['fresh'] }; };
  const corrected = { version: 'v1', query: { from: 'members' } };
  await runControlledTool('database', session, corrected, success);
  await runControlledTool('database', session, corrected, success);
  assert.equal(calls, 3); // This guard never caches successful results.
  finishToolRecoveryTurn(session);
  beginToolRecoveryTurn(session);
  await runControlledTool('database', session, { version: 'v1', query: {} }, execute);
  assert.equal(calls, 4);
});

test('confirmation remains available and transport diagnostics never expose exception messages or credentials', async t => {
  const session = 'recovery-confirmation-fixture';
  beginToolRecoveryTurn(session);
  t.after(() => finishToolRecoveryTurn(session));
  let calls = 0;
  const confirm = async () => { calls++; return { ok: false, error: { code: 'confirmation_required', message: 'not executed' } }; };
  await runControlledTool('api', session, { body: 'write' }, confirm);
  await runControlledTool('api', session, { body: 'write' }, confirm);
  assert.equal(calls, 2);
  const failure = toolRequestFailure(new TypeError('https://example.test/?token=secret', {
    cause: Object.assign(new Error('password=secret'), { code: 'ECONNRESET' }),
  }));
  assert.equal(failure.error.code, 'network_temporarily_unavailable');
  assert.doesNotMatch(JSON.stringify(failure), /secret|password|https/);
});

test('database retry starts a fresh read-only transaction and preserves bound query parameters', async t => {
  const database = new ReadDatabase({ databaseUrl: 'mysql://fixture:fixture@localhost/fixture', concurrency: 1, queryTimeoutMs: 2000 } as any);
  await database.close(); // The real, unused pool opens no connections.
  const commands: string[] = [];
  let acquired = 0;
  let retries = 0;
  (database as any).pool = {
    getConnection: async () => {
      const attempt = ++acquired;
      return {
        query: async ({ sql }: { sql: string }) => { commands.push(`${attempt}:${sql}`); return [[], []]; },
        execute: async ({ sql }: { sql: string }, bindings: unknown[]) => {
          commands.push(`${attempt}:${sql}`);
          assert.deepEqual(bindings, ['requested period', 'requested object']);
          if (attempt === 1) throw Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
          return [[{ id: 7 }], []];
        },
        release: () => {}, destroy: () => {},
      };
    },
    end: async () => {},
  };
  t.after(() => database.close());
  const rows = await database.read(query => query('SELECT fixture', ['requested period', 'requested object']), { retry: true, onRetry: () => { retries++; } });
  assert.deepEqual(rows, [{ id: 7 }]);
  assert.equal(acquired, 2);
  assert.equal(retries, 1);
  assert.equal(commands.filter(sql => sql.includes('START TRANSACTION READ ONLY')).length, 2);
  assert.equal(commands.filter(sql => sql.includes('SELECT fixture')).length, 2);
  (database as any).pool.getConnection = async () => ({
    query: async () => [[], []],
    execute: async () => {
      throw Object.assign(new Error('execution time exceeded'), { code: 'ER_QUERY_TIMEOUT' });
    },
    release: () => {}, destroy: () => {},
  });
  retries = 0;
  await assert.rejects(database.read(query => query('SELECT slow', [7]), {
    retry: true, onRetry: () => { retries++; },
  }), (error: any) => error.code === 'ER_QUERY_TIMEOUT');
  assert.equal(retries, 0);
});
