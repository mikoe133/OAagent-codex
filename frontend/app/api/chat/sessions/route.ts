import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { SESSION_COOKIE_NAME } from "@/lib/auth"

const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
const COPILOT_RECORD_SCHEMA = "oa-agent-chat/v1"
const DEFAULT_TITLE = "New Section"

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
  } | null
}

type CopilotRecordEnvelope = {
  data?: unknown
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
  imageData?: string
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

  const url = buildOaApiUrl("/copilot/list")
  if (!url) {
    return jsonResponse({ error: "OA API service is not configured" }, 500)
  }
  url.searchParams.set("page", "1")
  url.searchParams.set("size", "100")

  try {
    const upstreamResponse = await fetch(url, {
      method: "GET",
      headers: buildOaHeaders(sessionToken),
      cache: "no-store",
      signal: request.signal,
    })

    const text = await upstreamResponse.text()
    if (!upstreamResponse.ok) {
      return proxyTextResponse(upstreamResponse, text)
    }

    const payload = parseJson<CopilotListEnvelope>(text)
    return jsonDataResponse({ sessions: normalizeCopilotSessions(payload) }, upstreamResponse.status)
  } catch (error) {
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
  const recordBody = {
    schema: COPILOT_RECORD_SCHEMA,
    agentSessionId: sessionId,
    threadId: stringValue(body.threadId),
    summary,
    title,
    messages,
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
    const session = normalizeCopilotRecord(payload?.data) || buildFallbackSession(sessionId, messages)
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
      }),
      cache: "no-store",
      signal: request.signal,
    })

    const text = await upstreamResponse.text()
    if (!upstreamResponse.ok) {
      return proxyTextResponse(upstreamResponse, text)
    }

    const payload = parseJson<CopilotRecordEnvelope>(text)
    const session = normalizeCopilotRecord(payload?.data) || buildFallbackSession(sessionId)
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

async function readJsonBody(request: Request): Promise<CreateSessionBody> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === "object" ? (body as CreateSessionBody) : {}
  } catch {
    return {}
  }
}

function normalizeCopilotSessions(payload: CopilotListEnvelope | null): NormalizedSession[] {
  const items = payload?.data?.items
  if (!Array.isArray(items)) {
    return []
  }

  return dedupeSessionsBySessionId(items.map(normalizeCopilotRecord).filter((item): item is NormalizedSession => Boolean(item)))
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

  const createdAt = stringField(item, "created_at") || stringField(item, "createdAt") || new Date().toISOString()
  const updatedAt = stringField(item, "updated_at") || stringField(item, "updatedAt") || createdAt

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
      const session = await fetchRecordBySessionId(sessionToken, signal, input.sessionId)
      if (!session) {
        return jsonResponse({ error: "Copilot record not found" }, 404)
      }

      return jsonDataResponse({ session }, 200)
    }

    return jsonResponse({ error: "Invalid session request" }, 400)
  } catch (error) {
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
  const url = buildOaApiUrl("/copilot/list")
  if (!url) {
    throw new Error("OA API service is not configured")
  }
  url.searchParams.set("page", "1")
  url.searchParams.set("size", "100")

  const response = await fetch(url, {
    method: "GET",
    headers: buildOaHeaders(sessionToken),
    cache: "no-store",
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || response.statusText || "Failed to load copilot records")
  }

  return normalizeCopilotSessions(parseJson<CopilotListEnvelope>(text))
}

async function saveCopilotRecord(input: {
  sessionToken: string
  signal: AbortSignal
  recordId: string | null
  recordBody: Record<string, unknown>
}): Promise<{ response: Response; text: string }> {
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
    return { response, text }
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
}): Promise<{ response: Response; text: string }> {
  const createUrl = buildOaApiUrl("/copilot/record")
  if (!createUrl) {
    throw new Error("OA API service is not configured")
  }

  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: buildOaHeaders(input.sessionToken, "application/json"),
    body: JSON.stringify(input.recordBody),
    cache: "no-store",
    signal: input.signal,
  })
  const createText = await createResponse.text()

  if (!createResponse.ok) {
    return { response: createResponse, text: createText }
  }

  await deleteCopilotRecordBestEffort(input.sessionToken, input.signal, input.recordId)
  return { response: createResponse, text: createText }
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

function buildFallbackSession(sessionId: string, messages: NormalizedMessage[] = []): NormalizedSession {
  const now = new Date().toISOString()
  return {
    sessionId,
    threadId: null,
    summary: buildSummary(messages),
    createdAt: now,
    updatedAt: now,
    messages,
  }
}

function dedupeSessionsBySessionId(sessions: NormalizedSession[]): NormalizedSession[] {
  const bySessionId = new Map<string, NormalizedSession>()

  for (const session of sessions) {
    const existing = bySessionId.get(session.sessionId)
    if (!existing || compareUpdatedAt(session, existing) > 0) {
      bySessionId.set(session.sessionId, session)
    }
  }

  return [...bySessionId.values()].sort(compareUpdatedAt).reverse()
}

function compareUpdatedAt(left: NormalizedSession, right: NormalizedSession): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
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
  const content = stringField(item, "content")
  if (!role || !content) {
    return null
  }

  const createdAt = stringField(item, "createdAt") || stringField(item, "created_at") || new Date().toISOString()
  const imageData = stringField(item, "imageData")

  return {
    id: stringField(item, "id") || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    createdAt,
    ...(imageData ? { imageData } : {}),
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

function getOaApiBaseUrl(): string | null {
  return (
    readEnvValue("OA_API_BASE_URL") ||
    readEnvValue("AUTH_API_BASE_URL") ||
    readEnvValue("NEXT_PUBLIC_OA_API_BASE_URL") ||
    null
  )
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
