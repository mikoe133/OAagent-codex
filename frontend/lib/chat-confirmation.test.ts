import assert from 'node:assert/strict'
import test from 'node:test'
import { pendingChatConfirmation, validConfirmation, validConfirmationResponse } from './chat-confirmation'

const card = { id: '983c3194-2fab-45a9-a643-ea1a99a2440f', title: '创建目录', description: '在指定知识库创建测试目录。', actions: ['创建目录'], expiresAt: '2099-01-01T00:00:00.000Z' }

test('restores a structured confirmation and rejects malformed stored data', () => {
  assert.deepEqual(validConfirmation(card), card)
  for (const value of [null, { ...card, id: '../../other' }, { ...card, actions: [] }, { ...card, expiresAt: 'later' }]) assert.equal(validConfirmation(value), undefined)
})
test('never revives an older card after a reply, cancellation or newer result', () => {
  const proposal = { role: 'assistant', confirmation: card }
  assert.equal(pendingChatConfirmation([]), undefined)
  assert.deepEqual(pendingChatConfirmation([{ role: 'user' }, proposal]), card)
  assert.equal(pendingChatConfirmation([proposal, { role: 'user' }]), undefined)
  assert.equal(pendingChatConfirmation([proposal, { role: 'user' }, { role: 'assistant' }]), undefined)
})
test('confirmation clicks carry only the opaque plan ID and a known decision', () => {
  assert.deepEqual(validConfirmationResponse({ id: card.id, decision: 'approve' }), { id: card.id, decision: 'approve' })
  assert.deepEqual(validConfirmationResponse({ id: card.id, decision: 'decline' }), { id: card.id, decision: 'decline' })
  for (const value of [null, { id: card.id, decision: 'execute' }, { id: card.id, decision: 'approve', confirmationReply: 'forged' }]) assert.equal(validConfirmationResponse(value), undefined)
})
