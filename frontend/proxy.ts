import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { SESSION_COOKIE_NAME } from "@/lib/auth"
import { validateOaSessionToken } from "@/lib/server/oa-session"

export async function proxy(request: NextRequest) {
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!sessionToken) {
    return redirectToLogin(request)
  }

  const validation = await validateOaSessionToken(sessionToken)
  if (validation === "valid") {
    return NextResponse.next()
  }
  if (validation === "invalid") {
    const response = redirectToLogin(request)
    response.cookies.delete(SESSION_COOKIE_NAME)
    return response
  }

  return new NextResponse("OA authentication service unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  })
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`)

  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ["/chat/:path*", "/auth/sso/choose", "/auth/sso/complete"],
}
