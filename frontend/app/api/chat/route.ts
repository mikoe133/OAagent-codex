import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import {
  DEFAULT_MODEL_PROVIDER,
  isModelForProvider,
  isModelProvider,
  type ModelProvider,
} from "@/lib/model-catalog"

type ChatRequestBody = {
  messages?: unknown
  sessionId?: unknown
  provider?: unknown
  model?: unknown
}

type ChatMessage = {
  role?: unknown
  content?: unknown
  imageData?: unknown
}

type AgentStreamEvent = {
  type?: unknown
  delta?: unknown
  error?: unknown
  text?: unknown
  result?: {
    finalResponse?: unknown
    knowledgeSources?: unknown
  }
}

const DEFAULT_AGENT_API_BASE_URL = "http://127.0.0.1:3000"
const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/

export const runtime = "nodejs"

export async function POST(req: Request) {
  try {
    const body = await readJsonBody(req)
    const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : null

    if (!messages) {
      return jsonResponse({ error: "Invalid request: messages array required" }, 400)
    }

    const sessionToken = readCookie(req.headers.get("cookie"), SESSION_COOKIE_NAME)
    if (!sessionToken) {
      return jsonResponse({ error: "Authentication required" }, 401)
    }

    const message = resolveLatestUserMessage(messages)
    if (!message) {
      return jsonResponse({ error: "No valid user message to process" }, 400)
    }

    const sessionId = resolveAgentSessionId(body.sessionId)
    const provider = resolveRequestedProvider(body.provider)
    if (!provider) {
      return jsonResponse({ error: "Invalid provider" }, 400)
    }
    const model = resolveRequestedModel(body.model, provider)
    if (body.model !== undefined && !model) {
      return jsonResponse({ error: "Invalid model" }, 400)
    }
    const agentResponse = await fetch(buildAgentStreamUrl(sessionId), {
      method: "POST",
      headers: buildAgentHeaders(sessionToken),
      body: JSON.stringify({ message, provider, ...(model ? { model } : {}) }),
      signal: req.signal,
      cache: "no-store",
    })

    if (!agentResponse.ok) {
      const errorText = await agentResponse.text()
      return new Response(errorText || "Agent request failed", {
        status: agentResponse.status,
        headers: {
          "Content-Type": agentResponse.headers.get("content-type") || "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      })
    }

    if (!agentResponse.body) {
      return jsonResponse({ error: "Agent response did not include a stream" }, 502)
    }

    return new Response(streamAgentEvents(agentResponse.body), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    console.error("Chat API error:", error)
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Agent service is unavailable",
      },
      502,
    )
  }
}

async function readJsonBody(req: Request): Promise<ChatRequestBody> {
  try {
    const body = (await req.json()) as unknown
    return body && typeof body === "object" ? (body as ChatRequestBody) : {}
  } catch {
    return {}
  }
}

function resolveLatestUserMessage(messages: ChatMessage[]): string | null {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")
  if (!latestUserMessage || typeof latestUserMessage.content !== "string") {
    return null
  }

  const content = latestUserMessage.content.trim()
  if (!content) {
    return null
  }

  if (typeof latestUserMessage.imageData === "string" && latestUserMessage.imageData.startsWith("data:image/")) {
    return `${content}\n\n[用户上传了一张图片,当前 agent 服务只接收文本,图片内容未随请求发送。]`
  }

  return content
}

function resolveAgentSessionId(input: unknown): string {
  const sessionId = typeof input === "string" ? input.trim() : ""
  if (AGENT_SESSION_ID_PATTERN.test(sessionId)) {
    return sessionId
  }

  return `web-${randomUUID()}`
}

function resolveRequestedProvider(input: unknown): ModelProvider | null {
  if (input === undefined) {
    return DEFAULT_MODEL_PROVIDER
  }
  return isModelProvider(input) ? input : null
}

function resolveRequestedModel(input: unknown, provider: ModelProvider): string | null {
  if (typeof input !== "string") {
    return null
  }
  const model = input.trim()
  return isModelForProvider(provider, model) ? model : null
}

function buildAgentStreamUrl(sessionId: string): URL {
  return new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/messages/stream`, getAgentApiBaseUrl())
}

function buildAgentHeaders(sessionToken: string): Headers {
  const headers = new Headers({
    Accept: "text/event-stream",
    Authorization: toBearerToken(sessionToken),
    "Content-Type": "application/json",
  })

  return headers
}

function streamAgentEvents(agentBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = agentBody.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let emittedText = ""

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = ""
      let failed = false
      let terminalRunEventReceived = false

      const enqueueEvent = (event: AgentStreamEvent) => {
        controller.enqueue(encoder.encode(formatSseEvent(event)))
      }

      const handleAgentEvent = (event: AgentStreamEvent) => {
        if (event.type === "message.delta" && typeof event.delta === "string") {
          emittedText += event.delta
          enqueueEvent(event)
          return
        }

        if (event.type === "run.completed") {
          terminalRunEventReceived = true
          const finalResponse = event.result?.finalResponse
          if (typeof finalResponse === "string" && finalResponse && !emittedText) {
            emittedText = finalResponse
            enqueueEvent({
              type: "message.delta",
              delta: finalResponse,
              text: finalResponse,
            })
          }
          enqueueEvent(event)
          return
        }

        if (event.type === "run.failed") {
          failed = true
          terminalRunEventReceived = true
          enqueueEvent(event)
          return
        }

        enqueueEvent(event)
      }

      try {
        enqueueEvent({ type: "connected" })

        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          buffer = drainSseBuffer(buffer, handleAgentEvent)
        }

        buffer += decoder.decode()
        drainSseBuffer(`${buffer}\n\n`, handleAgentEvent)

        if (failed) {
          controller.close()
          return
        }

        if (!terminalRunEventReceived) {
          enqueueEvent({
            type: "run.failed",
            error: "Agent stream ended before a terminal run event.",
          })
        }

        controller.close()
      } catch (error) {
        enqueueEvent({
          type: "run.failed",
          error: error instanceof Error ? error.message : "Agent stream failed",
        })
        controller.close()
      } finally {
        reader.releaseLock()
      }
    },
    cancel() {
      void reader.cancel()
    },
  })
}

function formatSseEvent(event: AgentStreamEvent): string {
  const eventType = typeof event.type === "string" && event.type ? event.type : "message"
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`
}

function drainSseBuffer(buffer: string, onEvent: (event: AgentStreamEvent) => void): string {
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
      onEvent(JSON.parse(data) as AgentStreamEvent)
    } catch (error) {
      if (error instanceof SyntaxError) {
        continue
      }
      throw error
    }
  }

  return remainder
}

function jsonResponse(payload: { error: string }, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

function getAgentApiBaseUrl(): string {
  return (
    readEnvValue("AGENT_API_BASE_URL") ||
    readEnvValue("AGENT_BASE_URL") ||
    readEnvValue("NEXT_PUBLIC_AGENT_API_BASE_URL") ||
    DEFAULT_AGENT_API_BASE_URL
  )
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
