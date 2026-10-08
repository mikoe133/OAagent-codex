import assert from 'node:assert/strict'
import test from 'node:test'
import { completedRequestEvent } from './chat-run-recovery'

const completed = { recordId: '41', requestId: 'original', state: 'completed', result: { finalResponse: '等待确认', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', knowledgeSources: [], confirmation: { id: 'plan' } }, traceEvents: [{ type: 'confirmation.required' }] }
test('recovers the committed original result, trace and confirmation without resubmitting', () => {
  assert.deepEqual(completedRequestEvent(completed, '41', 'original'), { type: 'run.completed', result: { ...completed.result, traceEvents: completed.traceEvents } })
})
test('does not report another request or a noncompleted execution as success', () => {
  for (const value of [null, {}, { ...completed, recordId: '42' }, { ...completed, requestId: 'other' }, ...['queued', 'running', 'failed', 'cancelled', 'unknown'].map(state => ({ ...completed, state })), { ...completed, result: null }, { ...completed, result: { finalResponse: null } }]) assert.equal(completedRequestEvent(value, '41', 'original'), null)
})
