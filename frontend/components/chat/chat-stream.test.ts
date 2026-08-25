import assert from "node:assert/strict"
import test from "node:test"

import {
  createRequestRoutingTraceGate,
  drainChatSseBuffer,
  finalizeToolSteps,
  mergeMessageTraceDelta,
  mergeToolTimelineEvent,
  normalizeKnowledgeSources,
  requireCompletedChatRun,
  withTraceMessages,
  type ChatStreamEvent,
  type TraceMessage,
  type ToolStep,
} from "./chat-stream"

test("normalizes safe knowledge sources from a completed run", () => {
  assert.deepEqual(
    normalizeKnowledgeSources([
      {
        title: "生产部署手册",
        description: "发布前请确认数据库迁移。",
        originalContent: "较短原文。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
      {
        title: "生产部署手册",
        description: "发布前请确认数据库迁移。",
        originalContent: "发布前请确认数据库迁移、镜像版本和部署窗口。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
      {
        title: "危险链接",
        description: "不应显示",
        sourceUrl: "javascript:alert(1)",
      },
    ]),
    [
      {
        title: "生产部署手册",
        description: "发布前请确认数据库迁移。",
        originalContent: "发布前请确认数据库迁移、镜像版本和部署窗口。",
        sourceUrl: "https://oa-kb.example.test/wiki/page-1",
      },
    ],
  )
})

test("uses the displayed description as copy content for legacy knowledge sources", () => {
  assert.deepEqual(
    normalizeKnowledgeSources([
      {
        title: "旧版知识条目",
        description: "旧会话保存的摘要。",
        sourceUrl: "https://oa-kb.example.test/wiki/legacy-page",
      },
    ]),
    [
      {
        title: "旧版知识条目",
        description: "旧会话保存的摘要。",
        originalContent: "旧会话保存的摘要。",
        sourceUrl: "https://oa-kb.example.test/wiki/legacy-page",
      },
    ],
  )
})

test("withTraceMessages retains collected trace messages when a turn finishes", () => {
  const traceMessages: TraceMessage[] = [
    { id: "message-1", content: "Inspecting the project records." },
  ]

  assert.deepEqual(
    withTraceMessages({ status: "completed", durationMs: 3_452_600 }, traceMessages),
    {
      status: "completed",
      durationMs: 3_452_600,
      traceMessages,
    },
  )
})

test("drainChatSseBuffer preserves partial events between chunks", () => {
  const events: ChatStreamEvent[] = []
  const remainder = drainChatSseBuffer(
    'event: message.delta\ndata: {"type":"message.delta","delta":"Hel"}\n\n' +
      'event: message.delta\ndata: {"type":"message.delta",',
    (event) => events.push(event),
  )

  assert.deepEqual(events, [{ type: "message.delta", delta: "Hel" }])
  assert.equal(remainder, 'event: message.delta\ndata: {"type":"message.delta",')
})

test("requireCompletedChatRun rejects a stream that ended without run.completed", () => {
  assert.throws(
    () => requireCompletedChatRun(false),
    /stream ended before.*run\.completed/i,
  )
  assert.doesNotThrow(() => requireCompletedChatRun(true))
})

test("finalizeToolSteps never promotes a tool without tool.completed to success", () => {
  const runningStep: ToolStep = {
    id: "oa-query",
    type: "oa_api",
    status: "running",
    title: "OA API",
    description: "Calling project query",
  }

  assert.equal(finalizeToolSteps([runningStep], "completed")[0]?.status, "failed")
  assert.equal(finalizeToolSteps([runningStep], "failed")[0]?.status, "failed")
  assert.equal(finalizeToolSteps([runningStep], "stopped")[0]?.status, "info")
})

test("mergeToolTimelineEvent keeps one tool row and accumulates streamed output", () => {
  let steps: ToolStep[] = []

  steps = mergeToolTimelineEvent(steps, {
    type: "tool.started",
    itemId: "command-1",
    toolType: "command_execution",
    name: "npm run build",
    status: "in_progress",
  })
  steps = mergeToolTimelineEvent(steps, {
    type: "tool.updated",
    itemId: "command-1",
    status: "in_progress",
    outputDelta: "Compiling...\n",
  })
  steps = mergeToolTimelineEvent(steps, {
    type: "tool.completed",
    itemId: "command-1",
    toolType: "command_execution",
    name: "npm run build",
    status: "completed",
    outputDelta: "Build complete",
  })

  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0], {
    id: "command-1",
    type: "command_execution",
    status: "completed",
    title: "Command",
    description: "npm run build",
    input: "npm run build",
    output: "Compiling...\nBuild complete",
  })
})

test("mergeToolTimelineEvent updates request routing progress in one trace row", () => {
  let steps: ToolStep[] = []

  steps = mergeToolTimelineEvent(steps, {
    type: "progress",
    itemId: "request-routing",
    status: "in_progress",
    message: "正在理解请求并选择合适的数据源…",
  })
  steps = mergeToolTimelineEvent(steps, {
    type: "progress",
    itemId: "request-routing",
    status: "completed",
    message: "已准备好相关数据能力，正在生成回答…",
  })

  assert.deepEqual(steps, [
    {
      id: "request-routing",
      type: "request_routing",
      status: "completed",
      title: "任务编排",
      description: "已准备好相关数据能力，正在生成回答…",
    },
  ])
})

test("request routing trace waits five seconds and reveals only its latest state", () => {
  const visibleEvents: ChatStreamEvent[] = []
  let scheduledCallback: () => void = () => {
    assert.fail("routing trace callback was not scheduled")
  }
  let scheduledDelayMs: number | null = null
  const gate = createRequestRoutingTraceGate(
    (event) => visibleEvents.push(event),
    (callback, delayMs) => {
      scheduledCallback = callback
      scheduledDelayMs = delayMs
      return () => undefined
    },
  )

  assert.equal(
    gate.push({
      type: "progress",
      itemId: "request-routing",
      status: "in_progress",
      message: "正在理解请求并选择合适的数据源…",
    }),
    true,
  )
  assert.equal(
    gate.push({
      type: "progress",
      itemId: "request-routing",
      status: "completed",
      message: "已准备好相关数据能力，正在生成回答…",
    }),
    true,
  )
  assert.equal(scheduledDelayMs, 5_000)
  assert.deepEqual(visibleEvents, [])

  scheduledCallback()
  assert.deepEqual(visibleEvents, [
    {
      type: "progress",
      itemId: "request-routing",
      status: "completed",
      message: "已准备好相关数据能力，正在生成回答…",
    },
  ])
})

test("request routing trace stays hidden when another response arrives first", () => {
  const visibleEvents: ChatStreamEvent[] = []
  let scheduledCallback: () => void = () => {
    assert.fail("routing trace callback was not scheduled")
  }
  let cancelled = false
  const gate = createRequestRoutingTraceGate(
    (event) => visibleEvents.push(event),
    (callback) => {
      scheduledCallback = callback
      return () => {
        cancelled = true
      }
    },
  )

  gate.push({
    type: "progress",
    itemId: "request-routing",
    status: "in_progress",
    message: "正在理解请求并选择合适的数据源…",
  })
  gate.dismiss()

  assert.equal(cancelled, true)
  scheduledCallback()
  assert.deepEqual(visibleEvents, [])
  assert.equal(
    gate.push({
      type: "progress",
      itemId: "request-routing",
      status: "completed",
      message: "已准备好相关数据能力，正在生成回答…",
    }),
    true,
  )
  assert.deepEqual(visibleEvents, [])
})

test("mergeToolTimelineEvent keeps structured MCP input and result", () => {
  let steps: ToolStep[] = []

  steps = mergeToolTimelineEvent(steps, {
    type: "tool.started",
    itemId: "mcp-1",
    toolType: "mcp_tool_call",
    name: "oa.get_user",
    input: { userId: 42 },
    status: "in_progress",
  })
  steps = mergeToolTimelineEvent(steps, {
    type: "tool.completed",
    itemId: "mcp-1",
    toolType: "mcp_tool_call",
    name: "oa.get_user",
    result: { name: "Ada" },
    status: "completed",
  })

  assert.equal(steps[0]?.input, '{\n  "userId": 42\n}')
  assert.equal(steps[0]?.output, '{\n  "name": "Ada"\n}')
})

test("mergeToolTimelineEvent distinguishes OA and knowledge-base API calls", () => {
  let oaSteps: ToolStep[] = []
  oaSteps = mergeToolTimelineEvent(oaSteps, {
    type: "tool.started",
    itemId: "oa-api-1",
    toolType: "command_execution",
    name: "node scripts/callOaApi.mjs --operationId user_info_user_user_get --query '{}'",
    status: "in_progress",
  })
  oaSteps = mergeToolTimelineEvent(oaSteps, {
    type: "tool.updated",
    itemId: "oa-api-1",
    toolType: "command_execution",
    status: "in_progress",
    outputDelta: "Loading",
  })

  const knowledgeSteps = mergeToolTimelineEvent([], {
    type: "tool.completed",
    itemId: "knowledge-api-1",
    toolType: "command_execution",
    name: "node scripts/callKnowledgeBaseApi.mjs --operationId searchKnowledge --query '{}'",
    status: "completed",
  })

  assert.equal(oaSteps[0]?.type, "oa_api")
  assert.equal(oaSteps[0]?.title, "OA API")
  assert.equal(oaSteps[0]?.description, "Calling user_info_user_user_get")
  assert.equal(knowledgeSteps[0]?.type, "knowledge_base_api")
  assert.equal(knowledgeSteps[0]?.title, "OA 知识库")
  assert.equal(knowledgeSteps[0]?.description, "Calling searchKnowledge")
})

test("mergeMessageTraceDelta keeps separate agent messages and associates them with trace steps", () => {
  let messages: TraceMessage[] = []

  messages = mergeMessageTraceDelta(messages, {
    type: "message.delta",
    itemId: "message-1",
    delta: "I will inspect ",
    text: "I will inspect ",
  })
  messages = mergeMessageTraceDelta(messages, {
    type: "message.delta",
    itemId: "message-1",
    delta: "the records.",
    text: "I will inspect the records.",
  })
  messages = mergeMessageTraceDelta(
    messages,
    {
      type: "message.delta",
      itemId: "message-2",
      delta: "Now I will summarize the result.",
      text: "Now I will summarize the result.",
    },
    "command-1",
  )

  assert.deepEqual(messages, [
    {
      id: "message-1",
      content: "I will inspect the records.",
    },
    {
      id: "message-2",
      content: "Now I will summarize the result.",
      afterStepId: "command-1",
    },
  ])
})
