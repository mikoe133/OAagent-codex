import assert from 'node:assert/strict'
import test from 'node:test'
import { validAttachmentOptions } from './chat-attachments'

test('history restores per-message model override without accepting invalid model IDs', () => {
  const options = { mode: 'analyze', modelOverride: { provider: 'openrouter', model: 'moonshotai/kimi-k3' } }
  assert.deepEqual(validAttachmentOptions(options), options)
  assert.deepEqual(validAttachmentOptions({ mode: 'upload', target: '研发资料', modelOverride: { provider: 'openrouter', model: 'evil' } }), { mode: 'upload', target: '研发资料' })
})
