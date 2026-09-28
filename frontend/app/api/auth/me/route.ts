import { observeChatRoute, type ChatRequestDiagnostics } from "@/lib/server/chat-diagnostics"
import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { resolveOaSessionToken } from "@/lib/server/oa-session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = observeChatRoute("/api/auth/me", handleMe)

async function handleMe(request: NextRequest, diagnostics: ChatRequestDiagnostics) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value || ""
  if (!token) {
    return noStoreJson({ error: "unauthenticated" }, 401)
  }

  const resolution = await resolveOaSessionToken(token, (input, init) => diagnostics.fetch(input, init, "oa_auth"))
  if (resolution.status === "invalid") {
    diagnostics.phase = "oa_auth"
    return noStoreJson({ error: "invalid_session" }, 401)
  }
  if (resolution.status === "unavailable") {
    diagnostics.phase = "oa_auth"
    return noStoreJson({ error: "oa_unavailable" }, 503)
  }

  return noStoreJson({ user: resolution.user }, 200)
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}
