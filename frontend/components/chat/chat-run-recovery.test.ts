import assert from 'node:assert/strict'
import test from 'node:test'
import { completedRequestEvent, loadTerminalRequestEvent } from './chat-run-recovery'

const completed = { recordId: '41', requestId: 'original', state: 'completed', result: { finalResponse: '等待确认', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', knowledgeSources: [], confirmation: { id: 'plan' } }, traceEvents: [{ type: 'confirmation.required' }] }
test('recovers the committed original result, trace and confirmation without resubmitting', () => {
  assert.deepEqual(completedRequestEvent(completed, '41', 'original'), { type: 'run.completed', result: { ...completed.result, traceEvents: completed.traceEvents } })
})
test('does not report another request or a noncompleted execution as success', () => {
  for (const value of [null, {}, { ...completed, recordId: '42' }, { ...completed, requestId: 'other' }, ...['queued', 'running', 'failed', 'cancelled', 'unknown'].map(state => ({ ...completed, state })), { ...completed, result: null }, { ...completed, result: { finalResponse: null } }]) assert.equal(completedRequestEvent(value, '41', 'original'), null)
})

test('recovery preserves server duration and derives legacy durations only from server timestamps', () => {
  const request = { ...completed, createdAt: '2026-10-15T06:05:08.893Z', updatedAt: '2026-10-15T06:08:22.885Z' }
  assert.equal((completedRequestEvent({ ...request, durationMs: 47_525 }, '41', 'original')?.result as any)?.durationMs, 47_525)
  assert.equal((completedRequestEvent(request, '41', 'original')?.result as any)?.durationMs, 193_992)
  assert.equal((completedRequestEvent({ ...request, result: { ...request.result, durationMs: 0 } }, '41', 'original')?.result as any)?.durationMs, 0)
})

test('a stopped browser waits for the original cancellation to commit its server duration', async () => {
  const states = ['running', 'cancelled']
  let queries = 0
  const event = await loadTerminalRequestEvent(async () => ({
    recordId: '41', requestId: 'original', state: states[queries++],
    durationMs: 7_119, errorCode: 'cancelled', traceEvents: [{ type: 'run.failed' }],
  }), '41', 'original', { retryDelayMs: 0 })
  assert.equal(queries, 2)
  assert.deepEqual(event, {
    type: 'run.failed', state: 'cancelled', error: 'cancelled', durationMs: 7_119,
    traceEvents: [{ type: 'run.failed' }],
  })
})

test('a lost failure event recovers the server failure duration without resubmitting', async () => {
  const event = await loadTerminalRequestEvent(async () => ({
    recordId: '41', requestId: 'original', state: 'failed', durationMs: 684, errorCode: 'agent_failed',
  }), '41', 'original')
  assert.equal(event?.type, 'run.failed')
  assert.equal(event?.durationMs, 684)
  assert.equal(event?.error, 'agent_failed')
})

test('a completion racing with stop recovers the committed completed result', async () => {
  const event = await loadTerminalRequestEvent(async () => ({ ...completed, durationMs: 0 }), '41', 'original')
  assert.equal(event?.type, 'run.completed')
  assert.equal((event?.result as any)?.durationMs, 0)
})

test('terminal recovery is bounded and rejects mismatched or unknown requests', async () => {
  let queries = 0
  assert.equal(await loadTerminalRequestEvent(async () => {
    queries++
    return { ...completed, state: 'running' }
  }, '41', 'original', { maxAttempts: 2, retryDelayMs: 0 }), null)
  assert.equal(queries, 2)
  for (const value of [null, {}, { ...completed, requestId: 'other' }, { ...completed, state: 'unknown' }]) {
    assert.equal(await loadTerminalRequestEvent(async () => value, '41', 'original', { retryDelayMs: 0 }), null)
  }
})
