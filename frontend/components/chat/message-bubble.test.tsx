import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

import { MessageBubble } from "./message-bubble"
import type { Message } from "./chat-shell"

test("completed assistant replies expose copy and feedback actions", () => {
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: "**Ready.**",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
    feedback: "like",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} />)

  assert.match(html, /aria-label="Copy response"/)
  assert.match(html, /aria-label="Like response"/)
  assert.match(html, /aria-label="Dislike response"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /<strong>Ready\.<\/strong>/)
})

test("streaming assistant replies announce live output without feedback controls", () => {
  const message = {
    id: "assistant-2",
    role: "assistant",
    content: "Working",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "streaming",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} isStreaming />)

  assert.match(html, /Generating response/)
  assert.doesNotMatch(html, /aria-label="Copy response"/)
  assert.doesNotMatch(html, /aria-label="Like response"/)
  assert.doesNotMatch(html, /aria-label="Dislike response"/)
})

test("assistant replies expose completed tool activity and details", () => {
  const message = {
    id: "assistant-3",
    role: "assistant",
    content: "Build finished.",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
    toolSteps: [
      {
        id: "command-1",
        type: "command_execution",
        status: "completed",
        title: "Command",
        description: "npm run build",
        input: "npm run build",
        output: "Build complete",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} />)

  assert.match(html, /Tool activity/)
  assert.match(html, /npm run build/)
  assert.match(html, /Build complete/)
})
