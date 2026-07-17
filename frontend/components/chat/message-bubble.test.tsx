import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

import { MessageBubble } from "./message-bubble"
import type { Message } from "./chat-shell"

const OA_NAVIGATION_URL = "https://rwkv-oa.vercel.app/"

test("user messages expose a copy action beneath the bubble", () => {
  const message = {
    id: "user-1",
    role: "user",
    content: "Please summarize this document.",
    createdAt: new Date("2026-07-10T09:59:00.000Z"),
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /aria-label="Copy message"/)
})

test("user and assistant action controls reveal on hover or keyboard focus", () => {
  const userMessage = {
    id: "user-actions",
    role: "user",
    content: "User content",
    createdAt: new Date("2026-07-10T09:59:00.000Z"),
  } satisfies Message
  const assistantMessage = {
    id: "assistant-actions",
    role: "assistant",
    content: "Assistant content",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
  } satisfies Message

  const renderedMessages = [
    renderToStaticMarkup(<MessageBubble message={userMessage} oaNavigationUrl={OA_NAVIGATION_URL} />),
    renderToStaticMarkup(<MessageBubble message={assistantMessage} oaNavigationUrl={OA_NAVIGATION_URL} />),
  ]

  for (const html of renderedMessages) {
    assert.match(html, /group\/message/)
    assert.match(html, /pointer-fine:opacity-0/)
    assert.match(html, /pointer-fine:group-hover\/message:opacity-100/)
    assert.match(html, /pointer-fine:group-focus-within\/message:opacity-100/)
  }
})

test("completed assistant replies expose copy and feedback actions", () => {
  const message = {
    id: "assistant-1",
    role: "assistant",
    content: "**Ready.**",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
    feedback: "like",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /aria-label="Copy response"/)
  assert.match(html, /aria-label="Like response"/)
  assert.match(html, /aria-label="Dislike response"/)
  assert.match(html, /aria-label="Open OA"/)
  assert.match(html, /href="https:\/\/rwkv-oa\.vercel\.app\/"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /<strong>Ready\.<\/strong>/)
  assert.match(html, /data-slot="assistant-response"/)
  assert.doesNotMatch(html, /data-slot="streaming-message-trace"/)
})

test("streaming assistant replies announce live output without feedback controls", () => {
  const message = {
    id: "assistant-2",
    role: "assistant",
    content: "Working",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "streaming",
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(html, /Generating response/)
  assert.match(html, /data-slot="streaming-message-trace"/)
  assert.doesNotMatch(html, /data-slot="assistant-response"/)
  assert.doesNotMatch(html, /aria-label="Copy response"/)
  assert.doesNotMatch(html, /aria-label="Like response"/)
  assert.doesNotMatch(html, /aria-label="Dislike response"/)
  assert.doesNotMatch(html, /aria-label="Open OA"/)
})

test("streaming agent messages render as separate subdued trace steps in event order", () => {
  const message = {
    id: "assistant-trace-messages",
    role: "assistant",
    content: "I will inspect the records.Now I will summarize the result.",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "command-1",
        type: "command_execution",
        status: "completed",
        title: "Command",
        description: "Fetch records",
      },
    ],
    traceMessages: [
      {
        id: "message-1",
        content: "I will inspect the records.",
      },
      {
        id: "message-2",
        content: "Now I will summarize the result.",
        afterStepId: "command-1",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )
  const traceMessages = html.match(/data-slot="streaming-message-trace"/g) ?? []
  const firstMessageIndex = html.indexOf("I will inspect the records.")
  const toolIndex = html.indexOf("Fetch records")
  const secondMessageIndex = html.indexOf("Now I will summarize the result.")

  assert.equal(traceMessages.length, 2)
  assert.ok(firstMessageIndex < toolIndex)
  assert.ok(toolIndex < secondMessageIndex)
  assert.match(html, /data-trace-message-id="message-1"/)
  assert.match(html, /text-stone-400/)
  assert.match(html, /font-light/)
  assert.doesNotMatch(html, /data-slot="assistant-response"/)
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

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /Trace/)
  assert.match(html, /npm run build/)
  assert.match(html, /Build complete/)
})
