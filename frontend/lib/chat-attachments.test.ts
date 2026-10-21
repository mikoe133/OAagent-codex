import assert from 'node:assert/strict'
import test from 'node:test'
import { pastedImageFiles, validAttachmentOptions, validateAttachmentFiles } from './chat-attachments'

test('history restores per-message model override without accepting invalid model IDs', () => {
  const options = { mode: 'analyze', modelOverride: { provider: 'openrouter', model: 'moonshotai/kimi-k3' } }
  assert.deepEqual(validAttachmentOptions(options), options)
  assert.deepEqual(validAttachmentOptions({ mode: 'upload', target: '研发资料', modelOverride: { provider: 'openrouter', model: 'evil' } }), { mode: 'upload', target: '研发资料' })
})

const clipboard = (files: File[]) => ({
  items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })) as unknown as DataTransferItemList,
  files: files as unknown as FileList,
})

test('pastes clipboard images only for image-capable models and keeps text paste untouched', () => {
  const image = new File(['pixels'], 'screenshot.png', { type: 'image/png' })
  const text = new File(['text'], 'notes.txt', { type: 'text/plain' })
  const data = clipboard([image, text])
  for (const model of ['moonshotai/kimi-k3', 'qwen/qwen3.8-max-0902', 'deepseek/deepseek-v4.1-flash-1017']) {
    assert.deepEqual(pastedImageFiles(data, 'openrouter', model), [image])
  }
  assert.deepEqual(pastedImageFiles(data, 'openrouter', 'deepseek/deepseek-v4.1-flash'), [])
  assert.deepEqual(pastedImageFiles(data, 'nexttoken', 'gpt-5.6-terra'), [])
  assert.deepEqual(pastedImageFiles(clipboard([text]), 'openrouter', 'moonshotai/kimi-k3'), [])
})

test('supports clipboard file fallback and gives unnamed screenshot blobs an uploadable filename', () => {
  const image = new File(['pixels'], 'image', { type: 'image/png' })
  const data = { items: [] as unknown as DataTransferItemList, files: [image] as unknown as FileList }
  const pasted = pastedImageFiles(data, 'openrouter', 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(pasted.length, 1)
  assert.match(pasted[0].name, /\.png$/)
  assert.equal(pasted[0].type, 'image/png')
  assert.equal(pasted[0].size, image.size)
  assert.equal(validateAttachmentFiles(pasted), null)
})

test('pasted images share the existing count and size limits with selected files', () => {
  const image = new File(['pixels'], 'screenshot.png', { type: 'image/png' })
  const pasted = pastedImageFiles(clipboard([image]), 'openrouter', 'moonshotai/kimi-k3')
  assert.match(validateAttachmentFiles([...Array(5).fill(image), ...pasted])!, /最多选择 5/)
  const large = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
  assert.match(validateAttachmentFiles(pastedImageFiles(clipboard([large]), 'openrouter', 'moonshotai/kimi-k3'))!, /10 MB/)
})
