import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { proxy } from "./proxy"

test("redirects an invalid OA session token to login and clears the cookie", async () => {
  const originalFetch = globalThis.fetch
  const originalBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"

  globalThis.fetch = async () => Response.json({ code: 401, success: false }, { status: 401 })

  try {
    const response = await proxy(
      new NextRequest("http://localhost/chat", {
        headers: { cookie: "sessionid=invalid-token" },
      }),
    )

    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get("location") || "").pathname, "/login")
    assert.match(response.headers.get("set-cookie") || "", /sessionid=;/)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
  }
})

test("allows a valid OA session token", async () => {
  const originalFetch = globalThis.fetch
  const originalBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  let validationCookie: string | null = null

  globalThis.fetch = async (_input, init) => {
    validationCookie = new Headers(init?.headers).get("cookie")
    return Response.json({
      code: 200,
      success: true,
      data: { email: "user@example.test" },
    })
  }

  try {
    const response = await proxy(
      new NextRequest("http://localhost/chat", {
        headers: { cookie: "sessionid=valid-token" },
      }),
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("x-middleware-next"), "1")
    assert.equal(validationCookie, "sessionid=valid-token")
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
  }
})

test("fails closed when OA token validation is unavailable", async () => {
  const originalFetch = globalThis.fetch
  const originalBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"

  globalThis.fetch = async () => {
    throw new Error("connection refused")
  }

  try {
    const response = await proxy(
      new NextRequest("http://localhost/chat", {
        headers: { cookie: "sessionid=valid-token" },
      }),
    )

    assert.equal(response.status, 503)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("OA_API_BASE_URL", originalBaseUrl)
  }
})

test("protects SSO account selection and completion pages", async () => {
  for (const path of ["/auth/sso/choose", "/auth/sso/complete"]) {
    const response = await proxy(new NextRequest(`http://localhost${path}`))
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get("location") || "").pathname, "/login")
  }
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
