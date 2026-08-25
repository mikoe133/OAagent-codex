import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

import {
  MessageBubble,
  resolveTraceOpenState,
  resolveTraceSummaryText,
  truncateTraceSummaryText,
} from "./message-bubble"
import type { Message } from "./chat-shell"
import {
  calculateResponseDurationMs,
  formatResponseDuration,
  normalizeResponseDuration,
} from "@/lib/response-duration"

const OA_NAVIGATION_URL = "https://rwkv-oa.vercel.app/"

test("active trace updates preserve a manual collapsed state", () => {
  assert.equal(
    resolveTraceOpenState(false, {
      wasActive: true,
      isActive: true,
    }),
    false,
  )
  assert.equal(
    resolveTraceOpenState(false, {
      wasActive: false,
      isActive: true,
    }),
    true,
  )
})

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

test("user messages render without an avatar or name in a borderless gray bubble", () => {
  const message = {
    id: "user-minimal",
    role: "user",
    content: "Keep this message visually quiet.",
    createdAt: new Date("2026-07-10T09:59:00.000Z"),
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)
  const bubbleTag = html.match(/<div data-slot="user-message-bubble"[^>]*>/)?.[0]

  assert.ok(bubbleTag, "expected the user message bubble")
  assert.match(bubbleTag, /bg-\[#f5f5f5\]/)
  assert.doesNotMatch(bubbleTag, /\bborder(?:-|\b)/)
  assert.doesNotMatch(bubbleTag, /\bring(?:-|\b)/)
  assert.doesNotMatch(html, /lucide-user/)
  assert.doesNotMatch(html, />You<\/span>/)
})

test("assistant replies render without a visible agent header or animated avatar", () => {
  const message = {
    id: "assistant-without-avatar",
    role: "assistant",
    content: "Assistant content",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.doesNotMatch(html, />OA Agent<\/span>/)
  assert.doesNotMatch(html, />Working<\/span>/)
  assert.doesNotMatch(html, /orb-circle-/)
})

test("completed assistant replies show their processed duration instead of a clock time", () => {
  const message = {
    id: "assistant-with-duration",
    role: "assistant",
    content: "Assistant content",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    durationMs: 12_340,
    status: "completed",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /已处理: 12\.3 秒/)
})

test("response durations under one second are shown in milliseconds", () => {
  assert.equal(formatResponseDuration(850), "850 毫秒")
})

test("response duration calculation uses monotonic elapsed milliseconds", () => {
  assert.equal(calculateResponseDurationMs(100.2, 1_334.7), 1_235)
})

test("invalid persisted response durations are ignored", () => {
  assert.equal(normalizeResponseDuration(-1), undefined)
})

test("trace summaries prefer the last non-empty text message", () => {
  assert.equal(
    resolveTraceSummaryText(
      [
        { id: "first", content: "First update" },
        { id: "empty", content: "  " },
        { id: "last", content: "Latest update" },
      ],
      "Final response",
      [],
    ),
    "Latest update",
  )
})

test("long trace summaries end with an explicit ellipsis", () => {
  const summary = truncateTraceSummaryText(
    "This is a deliberately long trace message that should be shortened before it reaches the header.",
  )

  assert.equal(summary, "This is a deliberately long trace message that s...")
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

test("completed knowledge answers end with clickable source references", () => {
  const message = {
    id: "assistant-with-knowledge-sources",
    role: "assistant",
    content: "部署前需要完成数据库迁移检查。",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
    knowledgeSources: [
      {
        title: "生产部署手册",
        description: "发布前请确认数据库迁移、镜像版本和部署窗口。",
        originalContent: "发布前请确认数据库迁移、镜像版本和部署窗口的完整要求。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ],
  } as Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /data-slot="knowledge-source-showcase"/)
  assert.match(html, />知识库引用</)
  assert.match(html, />生产部署手册</)
  assert.match(html, /发布前请确认数据库迁移、镜像版本和部署窗口。/)
  assert.match(html, /href="https:\/\/oa-kb\.example\.test\/wiki\/page-1"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /aria-label="复制引用原文：生产部署手册"/)
  assert.match(
    html,
    /data-slot="knowledge-source-copy"[^>]*pointer-events-none[^>]*opacity-0[^>]*group-hover\/source:pointer-events-auto[^>]*group-hover\/source:opacity-100/,
  )
  assert.doesNotMatch(html, />知识库</)
  assert.doesNotMatch(html, /OA Knowledge/)
  assert.doesNotMatch(html, /bg-gradient-to-r/)
  assert.doesNotMatch(html, /data-slot="knowledge-source-preview"/)
  assert.doesNotMatch(html, /data-slot="knowledge-source-collapsible"/)
  assert.doesNotMatch(html, /data-slot="knowledge-source-showcase"[^>]*max-w-2xl/)
  assert.match(html, /w-2\/3 truncate/)
})

test("knowledge references beyond the first three are collapsed and expandable", () => {
  const message = {
    id: "assistant-with-many-knowledge-sources",
    role: "assistant",
    content: "这是包含多条引用的知识库回答。",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
    knowledgeSources: Array.from({ length: 5 }, (_, index) => ({
      title: `知识库文档 ${index + 1}`,
      description: `文档 ${index + 1} 的摘要。`,
      originalContent: `文档 ${index + 1} 的原文。`,
      sourceUrl: `https://oa-kb.example.test/wiki/page-${index + 1}`,
    })),
  } as Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)
  const collapsibleTag = html.match(/<details data-slot="knowledge-source-collapsible"[^>]*>/)?.[0]
  const sourceListTag = html.match(/<div data-slot="knowledge-source-list"[^>]*>/)?.[0]

  assert.ok(collapsibleTag, "expected the additional knowledge references to be collapsible")
  assert.ok(sourceListTag, "expected the knowledge source list")
  assert.doesNotMatch(collapsibleTag, /\bopen(?:=|\s|>)/)
  assert.doesNotMatch(collapsibleTag, /\bborder-(?:t|b)\b/)
  assert.doesNotMatch(sourceListTag, /\bborder-b\b/)
  assert.match(html, /data-slot="knowledge-source-toggle"/)
  assert.match(html, /data-slot="knowledge-source-row" data-bottom-border="hidden"[^>]*>[\s\S]*?知识库文档 3/)
  assert.match(html, />展开其余 2 条引用</)
  assert.match(html, /data-slot="knowledge-source-collapsed-list"/)
  assert.match(html, />知识库文档 1</)
  assert.match(html, />知识库文档 5</)
})

test("ordinary assistant answers do not render a source section", () => {
  const message = {
    id: "assistant-without-knowledge-sources",
    role: "assistant",
    content: "这是普通 OA 查询结果。",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "completed",
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.doesNotMatch(html, /data-slot="knowledge-source-showcase"/)
})

test("streaming assistant replies announce live output without feedback controls", () => {
  const message = {
    id: "assistant-2",
    role: "assistant",
    content: "Inspecting the request",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    status: "streaming",
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(html, /Generating response/)
  assert.doesNotMatch(html, />OA Agent<\/span>/)
  assert.doesNotMatch(html, />Working<\/span>/)
  assert.match(html, /data-slot="agent-trace"/)
  assert.match(html, /data-slot="agent-trace-trigger"/)
  assert.match(html, /data-state="open"/)
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
        input: "fetch --all",
        output: "Records fetched",
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
  const secondMessageIndex = html.lastIndexOf("Now I will summarize the result.")

  assert.equal(traceMessages.length, 2)
  assert.match(html, />Now I will summarize the result\.<\/span>/)
  assert.match(html, /flex-1 truncate text-\[(?:13px|0\.8125rem)\] font-normal/)
  assert.match(html, /text-stone-500/)
  assert.ok(firstMessageIndex < toolIndex)
  assert.ok(toolIndex < secondMessageIndex)
  assert.match(html, /data-trace-message-id="message-1"/)
  assert.match(html, /text-stone-400/)
  assert.match(html, /font-light/)
  assert.match(html, /fetch --all/)
  assert.match(html, /Records fetched/)
  assert.doesNotMatch(html, /data-slot="assistant-response"/)
  assert.doesNotMatch(html, /lucide-git-compare-arrows/)
  assert.doesNotMatch(html, /2 items active/)
  assert.doesNotMatch(html, /left-\[13px\] top-7 h-\[calc\(100%\+0\.25rem\)\] w-px bg-stone-200/)

  const traceItem = html.match(/<div[^>]*data-slot="agent-trace-item"[^>]*>/)?.[0]
  const summaryIcon = html.match(/<div data-slot="trace-summary-icon"[^>]*>/)?.[0]
  const messageIcon = html.match(/<span data-slot="trace-message-icon"[^>]*>/)?.[0]
  assert.ok(traceItem, "expected a trace accordion item")
  assert.ok(summaryIcon, "expected a trace summary icon")
  assert.ok(messageIcon, "expected a trace message icon")
  assert.match(html, /data-slot="trace-tool-icon"/)
  assert.match(html, /data-slot="trace-tool-status"/)
  assert.match(traceItem, /\bborder-0\b/)
  assert.doesNotMatch(traceItem, /border-stone/)
  assert.match(summaryIcon, /data-trace-state="active"/)
  assert.doesNotMatch(summaryIcon, /\btext-white\b/)
  assert.doesNotMatch(summaryIcon, /bg-emerald-50/)
  assert.doesNotMatch(summaryIcon, /\bborder(?:-|\b)/)
  assert.match(html, /data-slot="trace-summary-orb"/)
  assert.doesNotMatch(messageIcon, /\bborder(?:-|\b)/)
  assert.doesNotMatch(html, /data-slot="trace-tool-icon"[^>]*\bborder(?:-|\b)/)
  assert.match(html, /data-slot="trace-tool-status"[^>]*text-stone-400/)
  assert.match(html, /lucide-square-terminal[^>]*text-stone-700/)
})

test("completed assistant replies keep a trace entry when no tool was called", () => {
  const message = {
    id: "assistant-completed-trace-message",
    role: "assistant",
    content: "The project summary is ready.",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    durationMs: 3_452_600,
    status: "completed",
    traceMessages: [
      {
        id: "message-1",
        content: "Inspecting the project records.",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, /data-slot="agent-trace"/)
  assert.match(html, /data-slot="agent-trace-trigger"/)
  assert.match(html, /data-state="closed"/)
  assert.match(html, />Completed<\/span>/)
})

test("running trace nodes use the mint icon color", () => {
  const message = {
    id: "assistant-running-trace",
    role: "assistant",
    content: "",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    toolSteps: [
      {
        id: "tool-running",
        type: "web_search",
        status: "running",
        title: "Web Search",
        description: "Searching",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(html, /lucide-loader-circle[^>]*text-\[#b4fbde\]/)
})

test("Command traces use a dark square terminal icon with softer gray title and completion text", () => {
  const message = {
    id: "assistant-command-trace",
    role: "assistant",
    content: "执行完成。",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "command",
        type: "command_execution",
        status: "completed",
        title: "Command",
        description: "npm run build",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(html, /data-trace-tool-type="command_execution"/)
  assert.match(html, /lucide-square-terminal[^>]*text-stone-700/)
  assert.match(html, /text-stone-500[^>]*>Command<\/span>/)
  assert.match(html, /data-slot="trace-tool-status"[^>]*text-stone-400[^>]*>Complete<\/span>/)
})

test("request routing traces use a Signpost with Command trace gray styling", () => {
  const message = {
    id: "assistant-request-routing-trace",
    role: "assistant",
    content: "",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "request-routing",
        type: "request_routing",
        status: "completed",
        title: "任务编排",
        description: "已准备好相关数据能力，正在生成回答…",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(html, /data-trace-tool-type="request_routing"[^>]*bg-white/)
  assert.match(html, /lucide-signpost[^>]*text-stone-700/)
  assert.match(html, /text-stone-500[^>]*>任务编排<\/span>/)
  assert.match(html, /data-slot="trace-tool-status"[^>]*text-stone-400[^>]*>Complete<\/span>/)
  assert.match(html, /text-stone-500[^>]*>已准备好相关数据能力，正在生成回答…<\/p>/)
})

test("running request routing traces use gray status text", () => {
  const message = {
    id: "assistant-running-request-routing-trace",
    role: "assistant",
    content: "",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "request-routing",
        type: "request_routing",
        status: "running",
        title: "任务编排",
        description: "正在识别问题所需能力…",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(
    <MessageBubble message={message} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(
    html,
    /data-slot="trace-tool-status"[^>]*text-stone-400[^>]*theme-dark:text-zinc-500[^>]*>Running<\/span>/,
  )
  assert.doesNotMatch(html, /data-slot="trace-tool-status"[^>]*text-(?:emerald|cyan)/)
})

test("OA and knowledge-base traces use matching semantic icon, title, and completion colors", () => {
  const oaMessage = {
    id: "assistant-oa-api-trace",
    role: "assistant",
    content: "查询完成。",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "oa-api",
        type: "oa_api",
        status: "completed",
        title: "OA API",
        description: "Calling user_info_user_user_get",
      },
    ],
  } satisfies Message
  const knowledgeBaseMessage = {
    id: "assistant-knowledge-base-trace",
    role: "assistant",
    content: "查询完成。",
    createdAt: new Date("2026-07-10T10:02:00.000Z"),
    status: "streaming",
    toolSteps: [
      {
        id: "knowledge-base-api",
        type: "knowledge_base_api",
        status: "completed",
        title: "OA 知识库",
        description: "Calling searchKnowledge",
        input: "node scripts/callKnowledgeBaseApi.mjs --operationId searchKnowledge --query '{}'",
      },
    ],
  } satisfies Message

  const oaHtml = renderToStaticMarkup(
    <MessageBubble message={oaMessage} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )
  const knowledgeBaseHtml = renderToStaticMarkup(
    <MessageBubble message={knowledgeBaseMessage} isStreaming oaNavigationUrl={OA_NAVIGATION_URL} />,
  )

  assert.match(oaHtml, /data-trace-tool-type="oa_api"[^>]*bg-sky-50/)
  assert.match(oaHtml, /lucide-user-round-search[^>]*text-sky-600/)
  assert.match(oaHtml, /text-sky-600\/75[^>]*>OA API<\/span>/)
  assert.match(oaHtml, /data-slot="trace-tool-status"[^>]*text-sky-600\/60[^>]*>Complete<\/span>/)
  assert.match(knowledgeBaseHtml, /data-trace-tool-type="knowledge_base_api"[^>]*bg-amber-50/)
  assert.match(knowledgeBaseHtml, /lucide-library[^>]*text-amber-700/)
  assert.match(knowledgeBaseHtml, /text-amber-700\/75[^>]*>OA 知识库<\/span>/)
  assert.match(
    knowledgeBaseHtml,
    /data-slot="trace-tool-status"[^>]*text-amber-700\/60[^>]*>Complete<\/span>/,
  )
})

test("completed assistant traces show a completed status", () => {
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

  assert.match(html, />Completed<\/span>/)
  assert.doesNotMatch(html, />Trace<\/span>/)
  assert.doesNotMatch(html, /1 item completed/)
  assert.match(html, /data-slot="agent-trace-trigger"/)
  assert.match(html, /data-state="closed"/)
  assert.doesNotMatch(html, /data-slot="trace-summary-orb"/)
  assert.doesNotMatch(html, /npm run build/)
  assert.doesNotMatch(html, /Build complete/)
})

test("completed assistant traces report warnings when an intermediate command fails", () => {
  const message = {
    id: "assistant-completed-with-warning",
    role: "assistant",
    content: "The requested result was still produced.",
    createdAt: new Date("2026-07-10T10:01:00.000Z"),
    status: "completed",
    toolSteps: [
      {
        id: "command-failed",
        type: "command_execution",
        status: "failed",
        title: "Command",
        description: "python3 is unavailable",
        input: "python3 inspect.py",
        output: "python3: command not found",
      },
    ],
  } satisfies Message

  const html = renderToStaticMarkup(<MessageBubble message={message} oaNavigationUrl={OA_NAVIGATION_URL} />)

  assert.match(html, />Completed with warnings<\/span>/)
  assert.match(html, /data-trace-state="warning"/)
})
