import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { normalizeResponseDuration } from "@/lib/response-duration"
import {
  normalizeKnowledgeSources,
  type KnowledgeSource,
} from "@/lib/knowledge-sources"

const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
const COPILOT_RECORD_SCHEMA = "oa-agent-chat/v1"
const DEFAULT_TITLE = "New Section"
const COPILOT_LIST_PAGE_SIZE = 100
const MAX_COPILOT_LIST_PAGES = 50
const DEFAULT_AGENT_API_BASE_URL = "http://127.0.0.1:3000"

type CreateSessionBody = {
  sessionId?: unknown
  recordId?: unknown
  title?: unknown
  summary?: unknown
  threadId?: unknown
  messages?: unknown
}

type CopilotListEnvelope = {
  data?: {
    items?: unknown
    page?: unknown
    size?: unknown
    total?: unknown
  } | null
}

type CopilotRecordEnvelope = {
  data?: unknown
}

type AgentListEnvelope = {
  sessions?: unknown
}

type NormalizedSession = {
  sessionId: string
  threadId: string | null
  summary: string | null
  createdAt: string
  updatedAt: string
  recordId?: number | string
  messages?: NormalizedMessage[]
}

type NormalizedMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
  durationMs?: number
  imageData?: string
  toolSteps?: NormalizedToolStep[]
  traceMessages?: NormalizedTraceMessage[]
  knowledgeSources?: KnowledgeSource[]
  status?: "streaming" | "completed" | "stopped" | "failed"
  error?: string
  feedback?: "like" | "dislike"
}

type NormalizedToolStep = {
  id: string
  type: string
  status: string
  title: string
  description: string
  input?: string
  output?: string
}

type NormalizedTraceMessage = {
  id: string
  content: string
  afterStepId?: string
}

class UpstreamResponseError extends Error {
  constructor(
    readonly response: Response,
    readonly text: string,
  ) {
    super(text || response.statusText || "Upstream request failed")
  }
}

export const runtime = "nodejs"

export async function GET(request: Request) {
  const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME)
  if (!sessionToken) {
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  const requestUrl = new URL(request.url)
  const recordId = normalizeRecordId(requestUrl.searchParams.get("recordId"))
  const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"))
  if (recordId || sessionId) {
    return getSingleSession(sessionToken, request.signal, { recordId, sessionId })
  }

  try {
    const copilotSessions = await fetchSessionList(sessionToken, request.signal)
    const agentSessions = await fetchAgentSessionListBestEffort(request.signal, sessionToken)
    return jsonDataResponse({ sessions: mergeSessionSources(copilotSessions, agentSessions) }, 200)
  } catch (error) {
    if (error instanceof UpstreamResponseError) {
      return proxyTextResponse(error.response, error.text)
    }

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Copilot record service is unavailable",
      },
      502,
    )
  }
}

export async function PATCH(request: Request) {
  const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME)
  if (!sessionToken) {
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  const body = await readJsonBody(request)
  const sessionId = normalizeSessionId(body.sessionId)
  if (!sessionId) {
    return jsonResponse({ error: "Invalid sessionId" }, 400)
  }

  const messages = normalizeMessages(body.messages)
  const summary = stringValue(body.summary) || buildSummary(messages)
  const title = stringValue(body.title) || summary || DEFAULT_TITLE
  const createdAt = inferCreatedAtFromSessionId(sessionId)
  const recordBody = {
    schema: COPILOT_RECORD_SCHEMA,
    agentSessionId: sessionId,
    threadId: stringValue(body.threadId),
    summary,
    title,
    messages,
    ...(createdAt ? { createdAt } : {}),
  }

  try {
    const recordId = normalizeRecordId(body.recordId) || (await resolveRecordId(sessionToken, request.signal, sessionId))
    const saveResult = await saveCopilotRecord({
      sessionToken,
      signal: request.signal,
      recordId,
      recordBody,
    })

    const { response: upstreamResponse, text } = saveResult
    if (!upstreamResponse.ok) {
      return proxyTextResponse(upstreamResponse, text)
    }

    const payload = parseJson<CopilotRecordEnvelope>(text)
    const savedCreatedAt = normalizeTimestamp(saveResult.recordBody.createdAt)
    const normalizedSession = normalizeCopilotRecord(payload?.data)
    const session = normalizedSession
      ? { ...normalizedSession, createdAt: savedCreatedAt || normalizedSession.createdAt }
      : buildFallbackSession(sessionId, messages, savedCreatedAt)
    return jsonDataResponse({ session }, upstreamResponse.status)
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Copilot record service is unavailable",
      },
      502,
    )
  }
}

export async function POST(request: Request) {
  const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME)
  if (!sessionToken) {
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  const body = await readJsonBody(request)
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : ""
  if (!AGENT_SESSION_ID_PATTERN.test(sessionId)) {
    return jsonResponse({ error: "Invalid sessionId" }, 400)
  }

  const url = buildOaApiUrl("/copilot/record")
  if (!url) {
    return jsonResponse({ error: "OA API service is not configured" }, 500)
  }

  try {
    const createdAt = inferCreatedAtFromSessionId(sessionId) || new Date().toISOString()
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers: buildOaHeaders(sessionToken, "application/json"),
      body: JSON.stringify({
        schema: COPILOT_RECORD_SCHEMA,
        agentSessionId: sessionId,
        threadId: null,
        summary: null,
        title: DEFAULT_TITLE,
        messages: [],
        createdAt,
      }),
      cache: "no-store",
      signal: request.signal,
    })

    const text = await upstreamResponse.text()
    if (!upstreamResponse.ok) {
      return proxyTextResponse(upstreamResponse, text)
    }

    const payload = parseJson<CopilotRecordEnvelope>(text)
    const normalizedSession = normalizeCopilotRecord(payload?.data)
    const session = normalizedSession
      ? { ...normalizedSession, createdAt }
      : buildFallbackSession(sessionId, [], createdAt)
    return jsonDataResponse({ session, sessions: [session] }, upstreamResponse.status)
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Copilot record service is unavailable",
      },
      502,
    )
  }
}

export async function DELETE(request: Request) {
  const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME)
  if (!sessionToken) {
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  const body = await readJsonBody(request)
  const sessionId = normalizeSessionId(body.sessionId)
  if (!sessionId) {
    return jsonResponse({ error: "Invalid sessionId" }, 400)
  }

  try {
    const recordId = normalizeRecordId(body.recordId) || (await resolveRecordId(sessionToken, request.signal, sessionId))
    if (recordId) {
      await deleteCopilotRecord(sessionToken, request.signal, recordId)
    }
    await deleteAgentSession(request.signal, sessionId, sessionToken)
    return jsonDataResponse({ deleted: true, sessionId, recordId }, 200)
  } catch (error) {
    if (error instanceof UpstreamResponseError) {
      return proxyTextResponse(error.response, error.text)
    }

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Failed to delete chat session",
      },
      502,
    )
  }
}

async function readJsonBody(request: Request): Promise<CreateSessionBody> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === "object" ? (body as CreateSessionBody) : {}
  } catch {
    return {}
  }
}

function normalizeCopilotSessions(payload: CopilotListEnvelope | null): NormalizedSession[] {
  return normalizeCopilotItems(getCopilotListItems(payload))
}

function getCopilotListItems(payload: CopilotListEnvelope | null): unknown[] {
  const items = payload?.data?.items
  return Array.isArray(items) ? items : []
}

function normalizeCopilotItems(items: unknown[]): NormalizedSession[] {
  return items
    .map(normalizeCopilotRecord)
    .filter((item): item is NormalizedSession => Boolean(item))
    .sort(compareCreatedAtDescending)
}

function normalizeCopilotRecord(value: unknown): NormalizedSession | null {
  const item = toRecord(value)
  if (!item) {
    return null
  }

  const record = toRecord(item.record) || {}
  const recordId = stringOrNumberField(item, "id")
  const sessionId = stringField(record, "agentSessionId") || (recordId ? `record-${recordId}` : null)
  if (!sessionId) {
    return null
  }

  const createdAt =
    normalizeTimestamp(record.createdAt) ||
    inferCreatedAtFromSessionId(sessionId) ||
    normalizeTimestamp(item.created_at) ||
    normalizeTimestamp(item.createdAt) ||
    new Date().toISOString()
  const updatedAt = normalizeTimestamp(item.updated_at) || normalizeTimestamp(item.updatedAt) || createdAt

  return {
    sessionId,
    threadId: stringField(record, "threadId"),
    summary: stringField(record, "summary") || stringField(record, "title") || DEFAULT_TITLE,
    createdAt,
    updatedAt,
    ...(recordId ? { recordId } : {}),
    messages: normalizeMessages(record.messages),
  }
}

async function getSingleSession(
  sessionToken: string,
  signal: AbortSignal,
  input: { recordId: string | null; sessionId: string | null },
): Promise<Response> {
  try {
    if (input.recordId) {
      const session = await fetchRecordById(sessionToken, signal, input.recordId)
      if (!session) {
        return jsonResponse({ error: "Copilot record not found" }, 404)
      }

      return jsonDataResponse({ session }, 200)
    }

    if (input.sessionId) {
      const session =
        (await fetchRecordBySessionId(sessionToken, signal, input.sessionId)) ||
        (await fetchAgentSessionBySessionId(signal, input.sessionId, sessionToken))
      if (!session) {
        return jsonResponse({ error: "Copilot record not found" }, 404)
      }

      return jsonDataResponse({ session }, 200)
    }

    return jsonResponse({ error: "Invalid session request" }, 400)
  } catch (error) {
    if (error instanceof UpstreamResponseError) {
      return proxyTextResponse(error.response, error.text)
    }

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Copilot record service is unavailable",
      },
      502,
    )
  }
}

async function fetchRecordById(sessionToken: string, signal: AbortSignal, recordId: string): Promise<NormalizedSession | null> {
  const url = buildOaApiUrl("/copilot/record")
  if (!url) {
    throw new Error("OA API service is not configured")
  }
  url.searchParams.set("record_id", recordId)

  const response = await fetch(url, {
    method: "GET",
    headers: buildOaHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || response.statusText || "Failed to load copilot record")
  }

  const payload = parseJson<CopilotRecordEnvelope>(text)
  return normalizeCopilotRecord(payload?.data)
}

async function fetchRecordBySessionId(
  sessionToken: string,
  signal: AbortSignal,
  sessionId: string,
): Promise<NormalizedSession | null> {
  const sessions = await fetchSessionList(sessionToken, signal)
  return sessions.find((session) => session.sessionId === sessionId) || null
}

async function resolveRecordId(sessionToken: string, signal: AbortSignal, sessionId: string): Promise<string | null> {
  const session = await fetchRecordBySessionId(sessionToken, signal, sessionId)
  return session?.recordId ? String(session.recordId) : null
}

async function fetchSessionList(sessionToken: string, signal: AbortSignal): Promise<NormalizedSession[]> {
  const sessions: NormalizedSession[] = []
  let fetchedCount = 0
  let totalCount: number | null = null

  for (let page = 1; page <= MAX_COPILOT_LIST_PAGES; page += 1) {
    const payload = await fetchCopilotListPage(sessionToken, signal, page, COPILOT_LIST_PAGE_SIZE)
    const items = getCopilotListItems(payload)
    const pageTotal = numberField(toRecord(payload?.data) || {}, "total")

    sessions.push(...normalizeCopilotItems(items))
    fetchedCount += items.length
    totalCount = pageTotal ?? totalCount

    if (items.length === 0) {
      break
    }

    if (totalCount !== null && fetchedCount >= totalCount) {
      break
    }

    if (items.length < COPILOT_LIST_PAGE_SIZE) {
      break
    }
  }

  return dedupeSessionsBySessionId(sessions).sort(compareCreatedAtDescending)
}

async function fetchAgentSessionListBestEffort(
  signal: AbortSignal,
  sessionToken: string,
): Promise<NormalizedSession[]> {
  try {
    return await fetchAgentSessionList(signal, sessionToken)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    console.error("Failed to load agent sessions:", error)
    return []
  }
}

async function fetchAgentSessionBySessionId(
  signal: AbortSignal,
  sessionId: string,
  sessionToken: string,
): Promise<NormalizedSession | null> {
  try {
    const sessions = await fetchAgentSessionList(signal, sessionToken)
    return sessions.find((session) => session.sessionId === sessionId) || null
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    console.error("Failed to load agent session:", error)
    return null
  }
}

async function fetchAgentSessionList(
  signal: AbortSignal,
  sessionToken: string,
): Promise<NormalizedSession[]> {
  const response = await fetch(buildAgentSessionsUrl(), {
    method: "GET",
    headers: buildAgentHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || response.statusText || "Failed to load agent sessions")
  }

  return normalizeAgentSessions(parseJson<AgentListEnvelope>(text))
}

async function deleteAgentSession(
  signal: AbortSignal,
  sessionId: string,
  sessionToken: string,
): Promise<void> {
  const response = await fetch(buildAgentSessionUrl(sessionId), {
    method: "DELETE",
    headers: buildAgentHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || response.statusText || "Failed to delete agent session")
  }
}

async function fetchCopilotListPage(
  sessionToken: string,
  signal: AbortSignal,
  page: number,
  size: number,
): Promise<CopilotListEnvelope | null> {
  const url = buildOaApiUrl("/copilot/list")
  if (!url) {
    throw new Error("OA API service is not configured")
  }
  url.searchParams.set("page", String(page))
  url.searchParams.set("size", String(size))

  const response = await fetch(url, {
    method: "GET",
    headers: buildOaHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamResponseError(response, text)
  }

  return parseJson<CopilotListEnvelope>(text)
}

async function saveCopilotRecord(input: {
  sessionToken: string
  signal: AbortSignal
  recordId: string | null
  recordBody: Record<string, unknown>
}): Promise<{ response: Response; text: string; recordBody: Record<string, unknown> }> {
  const url = buildOaApiUrl("/copilot/record")
  if (!url) {
    throw new Error("OA API service is not configured")
  }

  if (input.recordId) {
    url.searchParams.set("record_id", input.recordId)
  }

  const response = await fetch(url, {
    method: input.recordId ? "PATCH" : "POST",
    headers: buildOaHeaders(input.sessionToken, "application/json"),
    body: JSON.stringify(input.recordBody),
    cache: "no-store",
    signal: input.signal,
  })
  const text = await response.text()

  const recordId = input.recordId
  if (!recordId || response.status !== 405) {
    return { response, text, recordBody: input.recordBody }
  }

  return replaceCopilotRecord({
    ...input,
    recordId,
  })
}

async function replaceCopilotRecord(input: {
  sessionToken: string
  signal: AbortSignal
  recordId: string
  recordBody: Record<string, unknown>
}): Promise<{ response: Response; text: string; recordBody: Record<string, unknown> }> {
  const createUrl = buildOaApiUrl("/copilot/record")
  if (!createUrl) {
    throw new Error("OA API service is not configured")
  }

  const recordBody = await preserveReplacementCreatedAt(input)
  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: buildOaHeaders(input.sessionToken, "application/json"),
    body: JSON.stringify(recordBody),
    cache: "no-store",
    signal: input.signal,
  })
  const createText = await createResponse.text()

  if (!createResponse.ok) {
    return { response: createResponse, text: createText, recordBody }
  }

  await deleteCopilotRecordBestEffort(input.sessionToken, input.signal, input.recordId)
  return { response: createResponse, text: createText, recordBody }
}

async function preserveReplacementCreatedAt(input: {
  sessionToken: string
  signal: AbortSignal
  recordId: string
  recordBody: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  if (normalizeTimestamp(input.recordBody.createdAt)) {
    return input.recordBody
  }

  try {
    const existingSession = await fetchRecordById(input.sessionToken, input.signal, input.recordId)
    if (existingSession) {
      return { ...input.recordBody, createdAt: existingSession.createdAt }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    console.error("Failed to preserve replaced copilot record creation time:", error)
  }

  return { ...input.recordBody, createdAt: new Date().toISOString() }
}

async function deleteCopilotRecordBestEffort(sessionToken: string, signal: AbortSignal, recordId: string): Promise<void> {
  const deleteUrl = buildOaApiUrl("/copilot/record")
  if (!deleteUrl) {
    return
  }
  deleteUrl.searchParams.set("record_id", recordId)

  try {
    const response = await fetch(deleteUrl, {
      method: "DELETE",
      headers: buildOaHeaders(sessionToken),
      cache: "no-store",
      signal,
    })
    if (!response.ok) {
      console.error("Failed to delete replaced copilot record:", await response.text())
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    console.error("Failed to delete replaced copilot record:", error)
  }
}

async function deleteCopilotRecord(sessionToken: string, signal: AbortSignal, recordId: string): Promise<void> {
  const deleteUrl = buildOaApiUrl("/copilot/record")
  if (!deleteUrl) {
    throw new Error("OA API service is not configured")
  }
  deleteUrl.searchParams.set("record_id", recordId)

  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: buildOaHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamResponseError(response, text)
  }
}

function buildFallbackSession(
  sessionId: string,
  messages: NormalizedMessage[] = [],
  originalCreatedAt?: string | null,
): NormalizedSession {
  const now = new Date().toISOString()
  return {
    sessionId,
    threadId: null,
    summary: buildSummary(messages),
    createdAt: originalCreatedAt || inferCreatedAtFromSessionId(sessionId) || now,
    updatedAt: now,
    messages,
  }
}

function dedupeSessionsBySessionId(sessions: NormalizedSession[]): NormalizedSession[] {
  const bySessionId = new Map<string, NormalizedSession>()

  for (const session of sessions) {
    const existing = bySessionId.get(session.sessionId)
    if (!existing || compareSessionFreshness(session, existing) > 0) {
      bySessionId.set(session.sessionId, session)
    }
  }

  return [...bySessionId.values()]
}

function mergeSessionSources(copilotSessions: NormalizedSession[], agentSessions: NormalizedSession[]): NormalizedSession[] {
  const copilotSessionIds = new Set(copilotSessions.map((session) => session.sessionId))
  return [
    ...copilotSessions,
    ...agentSessions.filter((session) => !copilotSessionIds.has(session.sessionId)),
  ].sort(compareCreatedAtDescending)
}

function compareCreatedAtDescending(left: NormalizedSession, right: NormalizedSession): number {
  const timestampOrder = compareTimestamps(left.createdAt, right.createdAt)
  return timestampOrder === 0 ? left.sessionId.localeCompare(right.sessionId) : -timestampOrder
}

function compareSessionFreshness(left: NormalizedSession, right: NormalizedSession): number {
  const timestampOrder = compareTimestamps(left.updatedAt, right.updatedAt)
  if (timestampOrder !== 0) {
    return timestampOrder
  }

  return compareRecordIds(left.recordId, right.recordId)
}

function compareTimestamps(left: string, right: string): number {
  const leftTimestamp = parseTimestamp(left)
  const rightTimestamp = parseTimestamp(right)
  if (leftTimestamp === rightTimestamp) {
    return 0
  }
  return leftTimestamp < rightTimestamp ? -1 : 1
}

function compareRecordIds(left: string | number | undefined, right: string | number | undefined): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber < rightNumber ? -1 : 1
  }

  return String(left ?? "").localeCompare(String(right ?? ""))
}

function normalizeAgentSessions(payload: AgentListEnvelope | null): NormalizedSession[] {
  const sessions = payload?.sessions
  if (!Array.isArray(sessions)) {
    return []
  }

  return sessions
    .map(normalizeAgentSession)
    .filter((session): session is NormalizedSession => Boolean(session))
    .sort(compareCreatedAtDescending)
}

function normalizeAgentSession(value: unknown): NormalizedSession | null {
  const item = toRecord(value)
  if (!item) {
    return null
  }

  const sessionId = normalizeSessionId(item.sessionId)
  if (!sessionId) {
    return null
  }

  const createdAt =
    normalizeTimestamp(item.createdAt) || inferCreatedAtFromSessionId(sessionId) || new Date().toISOString()
  const updatedAt = normalizeTimestamp(item.updatedAt) || createdAt

  return {
    sessionId,
    threadId: stringField(item, "threadId"),
    summary: stringField(item, "summary"),
    createdAt,
    updatedAt,
    messages: [],
  }
}

function normalizeMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalizeMessage).filter((message): message is NormalizedMessage => Boolean(message))
}

function normalizeMessage(value: unknown): NormalizedMessage | null {
  const item = toRecord(value)
  if (!item) {
    return null
  }

  const role = item.role === "user" || item.role === "assistant" ? item.role : null
  const content = stringField(item, "content") || ""
  const toolSteps = normalizeToolSteps(item.toolSteps)
  const traceMessages = normalizeTraceMessages(item.traceMessages)
  const knowledgeSources = normalizeKnowledgeSources(item.knowledgeSources)
  if (!role || (!content && toolSteps.length === 0)) {
    return null
  }

  const createdAt = stringField(item, "createdAt") || stringField(item, "created_at") || new Date().toISOString()
  const imageData = stringField(item, "imageData")
  const status = normalizeMessageStatus(item.status)
  const messageError = stringField(item, "error")
  const feedback = item.feedback === "like" || item.feedback === "dislike" ? item.feedback : null
  const durationMs = normalizeResponseDuration(item.durationMs)

  return {
    id: stringField(item, "id") || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    createdAt,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(imageData ? { imageData } : {}),
    ...(toolSteps.length > 0 ? { toolSteps } : {}),
    ...(traceMessages.length > 0 ? { traceMessages } : {}),
    ...(knowledgeSources.length > 0 ? { knowledgeSources } : {}),
    ...(status ? { status } : {}),
    ...(messageError ? { error: messageError } : {}),
    ...(feedback ? { feedback } : {}),
  }
}

function normalizeMessageStatus(value: unknown): NormalizedMessage["status"] {
  if (value === "streaming" || value === "completed" || value === "stopped" || value === "failed") {
    return value
  }
  return undefined
}

function normalizeToolSteps(value: unknown): NormalizedToolStep[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalizeToolStep).filter((step): step is NormalizedToolStep => Boolean(step))
}

function normalizeTraceMessages(value: unknown): NormalizedTraceMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalizeTraceMessage).filter((message): message is NormalizedTraceMessage => Boolean(message))
}

function normalizeTraceMessage(value: unknown): NormalizedTraceMessage | null {
  const item = toRecord(value)
  if (!item) {
    return null
  }

  const id = stringField(item, "id")
  const content = stringField(item, "content")
  const afterStepId = stringField(item, "afterStepId")
  if (!id || !content) {
    return null
  }

  return {
    id,
    content,
    ...(afterStepId ? { afterStepId } : {}),
  }
}

function normalizeToolStep(value: unknown): NormalizedToolStep | null {
  const item = toRecord(value)
  if (!item) {
    return null
  }

  const id = stringField(item, "id")
  const type = stringField(item, "type")
  const status = stringField(item, "status")
  const title = stringField(item, "title")
  const description = stringField(item, "description")
  const input = stringField(item, "input")
  const output = stringField(item, "output")

  if (!id || !type || !status || !title || !description) {
    return null
  }

  return {
    id,
    type,
    status,
    title,
    description,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  }
}

function buildSummary(messages: NormalizedMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim())
  return firstUserMessage?.content.trim() || DEFAULT_TITLE
}

function buildOaHeaders(sessionToken: string, contentType?: string): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: toBearerToken(sessionToken),
    Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
  })

  if (contentType) {
    headers.set("Content-Type", contentType)
  }

  return headers
}

function buildOaApiUrl(path: string): URL | null {
  const baseUrl = getOaApiBaseUrl()
  if (!baseUrl) {
    return null
  }

  const url = new URL(path, baseUrl)
  const alias = getOaApiAlias()
  if (alias) {
    url.searchParams.set("alias", alias)
  }
  return url
}

function buildAgentSessionsUrl(): URL {
  return new URL("/v1/sessions", getAgentApiBaseUrl())
}

function buildAgentSessionUrl(sessionId: string): URL {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, getAgentApiBaseUrl())
}

function buildAgentHeaders(sessionToken: string): Headers {
  return new Headers({
    Accept: "application/json",
    Authorization: toBearerToken(sessionToken),
  })
}

function getOaApiBaseUrl(): string | null {
  return (
    readEnvValue("OA_API_BASE_URL") ||
    readEnvValue("AUTH_API_BASE_URL") ||
    readEnvValue("NEXT_PUBLIC_OA_API_BASE_URL") ||
    null
  )
}

function getAgentApiBaseUrl(): string {
  return readEnvValue("AGENT_API_BASE_URL") || DEFAULT_AGENT_API_BASE_URL
}

function getOaApiAlias(): string {
  return readEnvValue("OA_AUTH_ALIAS") || readEnvValue("AUTH_API_ALIAS") || "default"
}

function jsonResponse(payload: { error: string }, status: number): Response {
  return jsonDataResponse(payload, status)
}

function jsonDataResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

function proxyTextResponse(response: Response, text: string): Response {
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

function parseJson<T>(text: string): T | null {
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalizeTimestamp(value: unknown): string | null {
  const timestamp = stringValue(value)
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null
}

function inferCreatedAtFromSessionId(sessionId: string): string | null {
  const match = /^web-(\d{12,14})-/.exec(sessionId)
  if (!match) {
    return null
  }

  const timestamp = Number(match[1])
  const date = new Date(timestamp)
  return Number.isFinite(timestamp) && !Number.isNaN(date.getTime()) ? date.toISOString() : null
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function normalizeSessionId(value: unknown): string | null {
  const sessionId = stringValue(value)
  return sessionId && AGENT_SESSION_ID_PATTERN.test(sessionId) ? sessionId : null
}

function normalizeRecordId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value)
  }

  const recordId = stringValue(value)
  return recordId && /^\d+$/.test(recordId) ? recordId : null
}

function stringOrNumberField(record: Record<string, unknown>, key: string): string | number | null {
  const value = record[key]
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  return null
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readEnvValue(key: string): string | null {
  return process.env[key]?.trim() || readSharedEnvValue(key)
}

function readSharedEnvValue(key: string): string | null {
  const cwd = process.cwd()
  const candidates = [
    resolve(cwd, ".env.local"),
    resolve(cwd, ".env"),
    resolve(cwd, "..", ".env.local"),
    resolve(cwd, "..", ".env"),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue
    }

    const value = readEnvFileValue(filePath, key)
    if (value) {
      return value
    }
  }

  return null
}

function readEnvFileValue(filePath: string, key: string): string | null {
  const content = readFileSync(filePath, "utf8")

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed
    if (!normalized.startsWith(`${key}=`)) {
      continue
    }

    const rawValue = normalized.slice(key.length + 1).trim()
    return rawValue.replace(/^['"]|['"]$/g, "").trim() || null
  }

  return null
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = cookie.trim().split("=")
    if (rawName !== name) {
      continue
    }

    const rawValue = valueParts.join("=")
    if (!rawValue) {
      return null
    }

    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }

  return null
}

function toBearerToken(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`
}
