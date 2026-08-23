export {
  normalizeKnowledgeSources,
  type KnowledgeSource,
} from "@/lib/knowledge-sources"

export type ToolStepStatus = "running" | "completed" | "failed" | "info"

export type ToolStep = {
  id: string
  type: string
  status: ToolStepStatus
  title: string
  description: string
  input?: string
  output?: string
}

const OA_API_TOOL_TYPE = "oa_api"
const KNOWLEDGE_BASE_API_TOOL_TYPE = "knowledge_base_api"

export type TraceMessage = {
  id: string
  content: string
  afterStepId?: string
}

export type ChatStreamEvent = {
  type?: unknown
  delta?: unknown
  detail?: unknown
  error?: unknown
  exitCode?: unknown
  input?: unknown
  itemId?: unknown
  message?: unknown
  name?: unknown
  outputDelta?: unknown
  result?: unknown
  status?: unknown
  text?: unknown
  toolType?: unknown
}

export function drainChatSseBuffer(buffer: string, onEvent: (event: ChatStreamEvent) => void): string {
  const chunks = buffer.replace(/\r\n/g, "\n").split("\n\n")
  const remainder = chunks.pop() || ""

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")

    if (!data) {
      continue
    }

    try {
      onEvent(JSON.parse(data) as ChatStreamEvent)
    } catch (error) {
      if (error instanceof SyntaxError) {
        continue
      }
      throw error
    }
  }

  return remainder
}

export function isToolTimelineEvent(eventType: string | null): boolean {
  return eventType === "tool.started" || eventType === "tool.updated" || eventType === "tool.completed" || eventType === "progress"
}

export function mergeToolTimelineEvent(steps: ToolStep[], event: ChatStreamEvent): ToolStep[] {
  const eventType = stringValue(event.type)
  if (!isToolTimelineEvent(eventType)) {
    return steps
  }

  const eventId = stringValue(event.itemId)
  const id = eventId || `progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const existingIndex = eventId ? steps.findIndex((step) => step.id === eventId) : -1
  const previous = existingIndex >= 0 ? steps[existingIndex] : null
  const nextStep = buildToolStep(event, id, previous)

  if (existingIndex < 0) {
    return [...steps, nextStep]
  }

  return steps.map((step, index) => (index === existingIndex ? nextStep : step))
}

export function mergeMessageTraceDelta(
  messages: TraceMessage[],
  event: ChatStreamEvent,
  afterStepId: string | null = null,
): TraceMessage[] {
  if (event.type !== "message.delta") {
    return messages
  }

  const delta = typeof event.delta === "string" ? event.delta : ""
  const cumulativeText = typeof event.text === "string" ? event.text : null
  if (!delta && cumulativeText === null) {
    return messages
  }

  const itemId = typeof event.itemId === "string" && event.itemId.trim()
    ? event.itemId.trim()
    : "message-current"
  const existingIndex = messages.findIndex((message) => message.id === itemId)
  const previous = existingIndex >= 0 ? messages[existingIndex] : null
  const content = cumulativeText ?? appendDelta(previous?.content ?? "", delta)
  const nextMessage: TraceMessage = {
    id: itemId,
    content,
    ...(previous?.afterStepId
      ? { afterStepId: previous.afterStepId }
      : afterStepId
        ? { afterStepId }
        : {}),
  }

  if (existingIndex < 0) {
    return [...messages, nextMessage]
  }

  return messages.map((message, index) => (index === existingIndex ? nextMessage : message))
}

export function withTraceMessages<T extends object>(
  message: T,
  traceMessages: TraceMessage[],
): T & { traceMessages?: TraceMessage[] } {
  return traceMessages.length > 0 ? { ...message, traceMessages } : message
}

export function requireCompletedChatRun(completed: boolean): void {
  if (!completed) {
    throw new Error("Agent stream ended before run.completed.")
  }
}

export function finalizeToolSteps(
  steps: ToolStep[],
  runStatus: "completed" | "failed" | "stopped",
): ToolStep[] {
  const incompleteStatus: ToolStepStatus = runStatus === "stopped" ? "info" : "failed"
  return steps.map((step) =>
    step.status === "running" ? { ...step, status: incompleteStatus } : step,
  )
}

function buildToolStep(event: ChatStreamEvent, id: string, previous: ToolStep | null): ToolStep {
  const eventType = stringValue(event.type)
  const previousRawToolType = previous?.type === OA_API_TOOL_TYPE || previous?.type === KNOWLEDGE_BASE_API_TOOL_TYPE
    ? "command_execution"
    : previous?.type
  const rawToolType = stringValue(event.toolType) || previousRawToolType || (eventType === "progress" ? "progress" : "tool")
  const name = stringValue(event.name)
  const toolType = resolveToolStepType(rawToolType, name, previous)
  const error = stringValue(event.error)
  const status = normalizeToolStatus(event.status, eventType, Boolean(error))
  const input = resolveToolInput(rawToolType, event, name, previous)
  const output = resolveToolOutput(rawToolType, event, error, previous)

  return {
    id,
    type: toolType,
    status,
    title: resolveToolTitle(toolType, name, previous),
    description: resolveToolDescription(toolType, event, name, status, previous),
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  }
}

function resolveToolStepType(rawToolType: string, name: string | null, previous: ToolStep | null): string {
  if (name?.includes("callKnowledgeBaseApi.mjs")) {
    return KNOWLEDGE_BASE_API_TOOL_TYPE
  }
  if (name?.includes("callOaApi.mjs")) {
    return OA_API_TOOL_TYPE
  }
  if (previous?.type === OA_API_TOOL_TYPE || previous?.type === KNOWLEDGE_BASE_API_TOOL_TYPE) {
    return previous.type
  }
  return rawToolType
}

function normalizeToolStatus(rawStatus: unknown, eventType: string | null, hasError: boolean): ToolStepStatus {
  if (hasError) {
    return "failed"
  }

  const status = stringValue(rawStatus)?.toLowerCase()
  if (status) {
    if (status === "info") {
      return "info"
    }
    if (/fail|error|cancel|rejected/.test(status)) {
      return "failed"
    }
    if (/complete|success|succeed|done|finished/.test(status)) {
      return "completed"
    }
    if (/running|progress|started|pending|queued|in_progress/.test(status)) {
      return "running"
    }
  }

  if (eventType === "tool.completed") {
    return "completed"
  }
  if (eventType === "tool.started" || eventType === "tool.updated") {
    return "running"
  }
  return "info"
}

function resolveToolTitle(toolType: string, name: string | null, previous: ToolStep | null): string {
  if (toolType === OA_API_TOOL_TYPE) {
    return "OA API"
  }
  if (toolType === KNOWLEDGE_BASE_API_TOOL_TYPE) {
    return "OA 知识库"
  }
  if (toolType === "command_execution") {
    return "Command"
  }
  if (toolType === "mcp_tool_call") {
    return "MCP tool"
  }
  if (toolType === "web_search") {
    return "Web search"
  }
  if (toolType === "progress") {
    return "Progress"
  }
  return previous?.title || "Tool"
}

function resolveToolDescription(
  toolType: string,
  event: ChatStreamEvent,
  name: string | null,
  status: ToolStepStatus,
  previous: ToolStep | null,
): string {
  const message = stringValue(event.message)
  if (message) {
    return compactText(message)
  }

  const error = stringValue(event.error)
  if (error) {
    return compactText(error)
  }

  if (toolType === "web_search") {
    const query = readQuery(event.input) || readQuery(event.result)
    if (query) {
      return compactText(query)
    }
  }

  if (name) {
    return describeToolName(name)
  }

  if (previous?.description) {
    return previous.description
  }

  if (status === "completed") {
    return "Completed"
  }
  if (status === "failed") {
    return "Failed"
  }
  return "Working"
}

function resolveToolInput(
  toolType: string,
  event: ChatStreamEvent,
  name: string | null,
  previous: ToolStep | null,
): string | null {
  if (event.input !== undefined) {
    return formatDetailValue(event.input)
  }
  if (toolType === "command_execution" && name) {
    return name
  }
  if (toolType === "web_search") {
    const query = readQuery(event.result)
    if (query) {
      return query
    }
  }
  return previous?.input || null
}

function resolveToolOutput(
  toolType: string,
  event: ChatStreamEvent,
  error: string | null,
  previous: ToolStep | null,
): string | null {
  let output = previous?.output || ""

  if (event.outputDelta !== undefined) {
    const delta = typeof event.outputDelta === "string" ? event.outputDelta : formatDetailValue(event.outputDelta)
    output = appendDelta(output, delta)
  }

  if (event.result !== undefined && toolType !== "web_search") {
    const result = formatDetailValue(event.result)
    output = mergeResult(output, result)
  }

  if (event.detail !== undefined && toolType === "progress") {
    output = formatDetailValue(event.detail)
  }

  if (error) {
    output = mergeResult(output, error)
  }

  return output || null
}

function appendDelta(previous: string, delta: string): string {
  if (!delta) {
    return previous
  }
  if (!previous) {
    return delta
  }
  if (delta.startsWith(previous)) {
    return delta
  }
  if (previous.endsWith(delta)) {
    return previous
  }
  return `${previous}${delta}`
}

function mergeResult(previous: string, result: string): string {
  if (!result) {
    return previous
  }
  if (!previous || result === previous || result.startsWith(previous)) {
    return result
  }
  if (previous.includes(result)) {
    return previous
  }
  return `${previous}\n${result}`
}

function readQuery(value: unknown): string | null {
  const record = toRecord(value)
  return record ? stringValue(record.query) : null
}

function describeToolName(name: string): string {
  const operationId = name.match(/--operationId\s+(['"]?)([^\s'"]+)\1/)?.[2]
  if ((name.includes("callOaApi.mjs") || name.includes("callKnowledgeBaseApi.mjs")) && operationId) {
    return `Calling ${operationId}`
  }
  return compactText(name)
}

function formatDetailValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim()
  }
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function compactText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}...` : normalized
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
