import assert from "node:assert/strict"
import test from "node:test"

import {
  drainChatSseBuffer,
  mergeToolTimelineEvent,
  type ChatStreamEvent,
  type ToolStep,
} from "./chat-stream"

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
    toolType: "command_execution",
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
