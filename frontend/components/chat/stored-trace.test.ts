import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreStoredTrace } from './stored-trace'
import { resolveLoadedSessionMessages } from './session-messages'
import { mergeToolTimelineEvent } from './chat-stream'

test('business failure is visible with zero shell exit, and subsequent retry retains its own success', () => {
  const failed = { type: 'tool.completed', toolType: 'command_execution', itemId: 'bad-format', status: 'completed', exitCode: 0,
    name: 'node scripts/callKnowledgeBaseApi.mjs --operationId getKnowledgeBasePage',
    outputDelta: JSON.stringify({ ok: false, status: 400, data: { error: { message: 'format unsupported' } } }) }
  const retry = { ...failed, itemId: 'retry', outputDelta: JSON.stringify({ ok: true, data: { content: 'page text' } }) }
  const restored = restoreStoredTrace([failed, retry])!
  assert.equal(restored.toolSteps[0]?.status, 'failed')
  assert.equal(restored.toolSteps[0]?.description, 'format unsupported')
  assert.equal(restored.toolSteps[1]?.status, 'completed')
})

test('semantic attachment decision and failure remain readable after history restoration', () => {
  for (const status of ['completed', 'failed']) {
    const event = {
      type: 'progress', itemId: 'attachment-intent-routing', toolType: 'attachment_route', status,
      message: status === 'completed' ? '需要读取图片，使用视觉模型' : '附件语义路由暂不可用，请明确需求后重试。',
      detail: { intent: status === 'completed' ? 'analyze' : 'clarify', requiresVision: status === 'completed' },
    }
    const live = mergeToolTimelineEvent([], event)
    assert.deepEqual(restoreStoredTrace([event])!.toolSteps, live)
    assert.equal(live[0]?.title, '附件用途判断')
    assert.equal(live[0]?.status, status)
    assert.equal(live[0]?.description, event.message)
    assert.match(live[0]?.output || '', /requiresVision/)
  }
})

test('model switch is readable in both live and restored traces', () => {
  const event = {
    type: 'progress', itemId: 'attachment-model-routing', toolType: 'model_switch', status: 'completed',
    message: '切换为 Kimi K3 模型用作文件解析（仅本次请求）',
    detail: { requested: { model: 'deepseek/deepseek-v4-flash' }, effective: { model: 'moonshotai/kimi-k3' } },
  }
  const live = mergeToolTimelineEvent([], event)
  const restored = restoreStoredTrace([event])!
  assert.deepEqual(restored.toolSteps, live)
  assert.equal(live[0]?.title, '文件解析模型')
  assert.equal(live[0]?.description, event.message)
  assert.equal(live[0]?.status, 'completed')
  assert.match(live[0]?.output || '', /deepseek-v4-flash/)
});

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
