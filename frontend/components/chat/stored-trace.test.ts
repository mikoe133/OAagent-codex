import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreStoredTrace } from './stored-trace'
import { resolveLoadedSessionMessages } from './session-messages'

test('restores tool inputs, output, duration and interleaved messages from a saved journal', () => {
  const restored = restoreStoredTrace([
    { type: 'message.delta', itemId: 'intro', delta: '查询中' },
    { type: 'tool.started', itemId: 'api', toolType: 'command_execution', name: 'node scripts/callOaApi.mjs --operationId list_reports' },
    { type: 'tool.updated', itemId: 'api', toolType: 'command_execution', outputDelta: 'one' },
    { type: 'tool.completed', itemId: 'api', toolType: 'command_execution', status: 'completed', outputDelta: ' two', durationMs: 42 },
    { type: 'message.delta', itemId: 'answer', delta: 'ha' },
    { type: 'message.delta', itemId: 'answer', delta: 'ha' },
  ])!
  assert.equal(restored.toolSteps[0]?.type, 'oa_api')
  assert.equal(restored.toolSteps[0]?.output, 'one two')
  assert.equal(restored.toolSteps[0]?.durationMs, 42)
  assert.equal(restored.toolSteps[0]?.status, 'completed')
  assert.deepEqual(restored.traceMessages, [
    { id: 'intro', content: '查询中' }, { id: 'answer', content: 'haha', afterStepId: 'api' },
  ])
})

test('restores replacements and finalizes interrupted tools without inventing a successful completion', () => {
  const events = [
    { type: 'tool.started', itemId: 'tool', name: 'search' },
    { type: 'message.delta', itemId: 'answer', delta: 'old' },
    { type: 'message.delta', itemId: 'answer', delta: 'new', replaceText: true },
  ]
  assert.equal(restoreStoredTrace(events, 'failed')?.toolSteps[0]?.status, 'failed')
  assert.equal(restoreStoredTrace(events, 'stopped')?.toolSteps[0]?.status, 'info')
  assert.equal(restoreStoredTrace(events)?.traceMessages[0]?.content, 'new')
  assert.equal(restoreStoredTrace(undefined), undefined)
})

test('loads saved traces over a stale browser snapshot while preserving an active stream', () => {
  const cached = [{ id: 'answer', content: 'old' }]
  const persisted = [{ id: 'answer', content: 'final', traceMessages: [{ id: 'm', content: 'trace' }] }]
  assert.deepEqual(resolveLoadedSessionMessages(cached, persisted, false), persisted)
  assert.equal(resolveLoadedSessionMessages(cached, persisted, true), cached)
})
