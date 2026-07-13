import assert from "node:assert/strict"
import test from "node:test"

import { resolveMessageListOverflow } from "./message-list-layout"

test("empty chat hides overflow instead of showing a scrollbar", () => {
  assert.equal(
    resolveMessageListOverflow({ messageCount: 0, isStreaming: false, hasError: false }),
    "overflow-hidden",
  )
})

test("chat content keeps vertical scrolling enabled", () => {
  assert.equal(
    resolveMessageListOverflow({ messageCount: 1, isStreaming: false, hasError: false }),
    "overflow-y-auto",
  )
  assert.equal(
    resolveMessageListOverflow({ messageCount: 0, isStreaming: true, hasError: false }),
    "overflow-y-auto",
  )
  assert.equal(
    resolveMessageListOverflow({ messageCount: 0, isStreaming: false, hasError: true }),
    "overflow-y-auto",
  )
})
