import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { GET } from "./route"

test("returns the canonical OA user for the HttpOnly session", async () => {
  const restore = configureAuthEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ code: 200, success: true, data: { id: 7, email: "USER@EXAMPLE.TEST" } })

  try {
    const response = await GET(
      new NextRequest("http://localhost/api/auth/me", {
        headers: { cookie: "sessionid=current-token" },
      }),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      user: { id: 7, email: "user@example.test" },
    })
    assert.equal(response.headers.get("cache-control"), "no-store")
  } finally {
    globalThis.fetch = originalFetch
    restore()
  }
})

test("rejects a request without an Agent session", async () => {
  const response = await GET(new NextRequest("http://localhost/api/auth/me"))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: "unauthenticated" })
})

function configureAuthEnvironment(): () => void {
  const originalBaseUrl = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = "https://oa.example.test"
  return () => restoreEnv("OA_API_BASE_URL", originalBaseUrl)
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
