import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { readServerEnvValue } from "@/lib/server/server-env"

const MAX_REQUEST_BODY_BYTES = 256 * 1024
const AUTOMATION_REQUEST_TIMEOUT_MS = 20_000

type RouteContext = {
  params: Promise<{ segments: string[] }>
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, context: RouteContext) {
  return proxyAutomationRequest(request, context, "GET")
}

export async function POST(request: Request, context: RouteContext) {
  return proxyAutomationRequest(request, context, "POST")
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxyAutomationRequest(request, context, "PATCH")
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyAutomationRequest(request, context, "DELETE")
}

async function proxyAutomationRequest(
  request: Request,
  context: RouteContext,
  method: HttpMethod,
): Promise<Response> {
  const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME)
  if (!sessionToken) {
    return jsonResponse({ error: "Authentication required" }, 401)
  }

  const { segments } = await context.params
  const upstreamPath = resolveUpstreamPath(segments, method)
  if (!upstreamPath) {
    return jsonResponse({ error: "Automation API route not found" }, 404)
  }

  const baseUrl = getAutomationApiBaseUrl()
  if (!baseUrl) {
    return jsonResponse({ error: "Automation API service is not configured" }, 500)
  }

  const incomingUrl = new URL(request.url)
  const upstreamUrl = new URL(upstreamPath, ensureTrailingSlash(baseUrl))
  incomingUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.append(key, value)
  })
  const alias = getOaAuthAlias()
  if (alias && !upstreamUrl.searchParams.has("alias")) {
    upstreamUrl.searchParams.set("alias", alias)
  }

  let body: string | undefined
  if (method === "POST" || method === "PATCH") {
    body = await request.text()
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return jsonResponse({ error: "Request body is too large" }, 413)
    }
  }

  try {
    const headers = new Headers({
      Accept: "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    })
    if (!upstreamPath.startsWith("/automation-prompt-profiles/")) {
      headers.set("Authorization", `Bearer ${sessionToken}`)
    }
    if (body !== undefined) {
      headers.set("Content-Type", "application/json")
    }
    const response = await fetch(upstreamUrl, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(AUTOMATION_REQUEST_TIMEOUT_MS),
      ]),
    })
    const responseBody = await response.text()
    return new Response(responseBody, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ||
          "application/json; charset=utf-8",
      },
    })
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Automation API service is unavailable",
      },
      502,
    )
  }
}

function resolveUpstreamPath(segments: string[], method: HttpMethod): string | null {
  const path = segments.join("/")
  if (path === "models" && method === "GET") {
    return "/automation-models"
  }
  if (
    path === "prompt-profiles/github_project_progress_sync" &&
    (method === "GET" || method === "PATCH")
  ) {
    return "/automation-prompt-profiles/github_project_progress_sync"
  }
  if (path === "tags" && (method === "GET" || method === "POST")) {
    return "/automation-tags"
  }
  const tagMatch = path.match(/^tags\/(\d+)$/)
  if (tagMatch && (method === "PATCH" || method === "DELETE")) {
    return `/automation-tags/${tagMatch[1]}`
  }
  if (path === "jobs" && (method === "GET" || method === "POST")) {
    return "/automation-jobs"
  }
  const jobMatch = path.match(/^jobs\/(\d+)$/)
  if (jobMatch && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    return `/automation-jobs/${jobMatch[1]}`
  }
  const jobActionMatch = path.match(/^jobs\/(\d+)\/(validate|runs)$/)
  if (jobActionMatch && method === "POST") {
    return `/automation-jobs/${jobActionMatch[1]}/${jobActionMatch[2]}`
  }
  if (path === "runs" && method === "GET") {
    return "/automation-job-runs"
  }
  const runMatch = path.match(/^runs\/([A-Za-z0-9-]{1,64})$/)
  if (runMatch && method === "GET") {
    return `/automation-job-runs/${runMatch[1]}`
  }
  const traceMatch = path.match(/^runs\/([A-Za-z0-9-]{1,64})\/trace-events$/)
  if (traceMatch && method === "GET") {
    return `/automation-job-runs/${traceMatch[1]}/trace-events`
  }
  const cancelMatch = path.match(/^runs\/([A-Za-z0-9-]{1,64})\/cancel$/)
  if (cancelMatch && method === "POST") {
    return `/automation-job-runs/${cancelMatch[1]}/cancel`
  }
  return null
}

function getAutomationApiBaseUrl(): string | null {
  return (
    readServerEnvValue("AUTOMATION_API_BASE_URL") ||
    readServerEnvValue("NEXT_PUBLIC_AUTOMATION_API_BASE_URL") ||
    readServerEnvValue("OA_API_BASE_URL") ||
    readServerEnvValue("AUTH_API_BASE_URL") ||
    readServerEnvValue("NEXT_PUBLIC_OA_API_BASE_URL") ||
    null
  )
}

function getOaAuthAlias(): string {
  return readServerEnvValue("OA_AUTH_ALIAS") ||
    readServerEnvValue("AUTH_API_ALIAS") ||
    "default"
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue
    }
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}
