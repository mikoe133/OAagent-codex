import { NextRequest, NextResponse } from "next/server"

import { resolveOaSessionToken } from "@/lib/server/oa-session"
import {
  SSO_PENDING_COOKIE_NAME,
  clearPendingSsoCookie,
  setAgentSessionCookie,
} from "@/lib/server/sso-cookies"
import {
  consumePendingSsoHandoff,
  discardPendingSsoHandoff,
  getPendingSsoHandoff,
} from "@/lib/server/sso-handoff-store"

type Decision = "keep-current" | "use-oa"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const pendingId = request.cookies.get(SSO_PENDING_COOKIE_NAME)?.value || ""
  const handoff = getPendingSsoHandoff(pendingId)
  if (!handoff) {
    return redirectWithError(request, "invalid_or_expired")
  }

  const decision = await readDecision(request)
  if (!decision) {
    return redirectWithError(request, "invalid_decision")
  }

  if (decision === "keep-current") {
    discardPendingSsoHandoff(pendingId)
    const response = noStoreRedirect(new URL("/chat", request.url))
    clearPendingSsoCookie(response)
    return response
  }

  const validation = await resolveOaSessionToken(handoff.token)
  if (validation.status !== "valid" || validation.user.email !== handoff.user.email) {
    discardPendingSsoHandoff(pendingId)
    return redirectWithError(
      request,
      validation.status === "unavailable" ? "oa_unavailable" : "incoming_session_invalid",
    )
  }

  const consumed = consumePendingSsoHandoff(pendingId)
  if (!consumed) {
    return redirectWithError(request, "invalid_or_expired")
  }

  const response = noStoreRedirect(new URL("/auth/sso/complete", request.url))
  setAgentSessionCookie(response, consumed.token)
  clearPendingSsoCookie(response)
  return response
}

async function readDecision(request: Request): Promise<Decision | null> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { decision?: unknown }
      return isDecision(body.decision) ? body.decision : null
    } catch {
      return null
    }
  }

  try {
    const formData = await request.formData()
    const decision = formData.get("decision")
    return isDecision(decision) ? decision : null
  } catch {
    return null
  }
}

function isDecision(value: unknown): value is Decision {
  return value === "keep-current" || value === "use-oa"
}

function redirectWithError(request: NextRequest, error: string): NextResponse {
  const url = new URL("/login", request.url)
  url.searchParams.set("sso_error", error)
  const response = noStoreRedirect(url)
  clearPendingSsoCookie(response)
  return response
}

function noStoreRedirect(url: URL): NextResponse {
  const response = NextResponse.redirect(url, 303)
  response.headers.set("Cache-Control", "no-store")
  response.headers.set("Referrer-Policy", "no-referrer")
  return response
}
