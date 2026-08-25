import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { resolveMessageListOverflow } from "./message-list-layout"

const messageListSource = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8")

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

test("reply scrolling reserves space above the fixed composer", () => {
  assert.match(messageListSource, /max-w-5xl flex-col gap-7 px-4 pb-40 pt-24/)
})

test("chat messages use a thin borderless scrollbar", () => {
  assert.match(messageListSource, /chat-message-scrollbar absolute inset-0 border-none/)
})
