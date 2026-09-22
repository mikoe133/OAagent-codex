import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "./chat-shell"
import { LEGACY_MESSAGE_RETRY_HINT, resolveMessageRetry } from "./message-retry"

function userMessage(id: string): Message {
  return { id, role: "user", content: "如何报销？", createdAt: new Date("2026-08-25T09:56:20Z") }
}

test("legacy messages have no retry target and receive manual resend guidance", () => {
  const messages: Message[] = [userMessage("1787651780510-pwgymwz"), {
    id: "1787651780511-wq8z8xs", role: "assistant", content: "", status: "failed",
    error: "网络连接中断", createdAt: new Date("2026-08-25T09:56:20Z"),
  }]
  const snapshot = structuredClone(messages)
  assert.deepEqual(resolveMessageRetry(messages), { target: null, hint: LEGACY_MESSAGE_RETRY_HINT })
  assert.deepEqual(messages, snapshot, "history and the original failure must remain intact")
})

test("a new message in an old conversation retries with its original request id", () => {
  const messages = [userMessage("1787651780510-pwgymwz"), userMessage("request-123:user")]
  const retry = resolveMessageRetry(messages)
  assert.equal(retry.target?.requestId, "request-123")
  assert.equal(retry.target?.message, messages[1])
  assert.equal(retry.hint, undefined)
})

test("retry never falls back to an earlier request when the last user message has no valid key", () => {
  for (const id of ["legacy-message", ":user", "invalid key:user", `${"a".repeat(121)}:user`]) {
    const messages = [userMessage("earlier:user"), userMessage(id)]
    assert.equal(resolveMessageRetry(messages).target, null)
  }
})

test("assistant messages cannot supply a retry key", () => {
  const assistant: Message = { ...userMessage("unrelated:user"), role: "assistant" }
  assert.deepEqual(resolveMessageRetry([]), { target: null, hint: undefined })
  assert.deepEqual(resolveMessageRetry([assistant]), { target: null, hint: undefined })
  assert.equal(resolveMessageRetry([userMessage("original:user"), assistant]).target?.requestId, "original")
})
