import assert from 'node:assert/strict'
import test from 'node:test'
import { POST as login } from '../auth/login/route'
import { GET, POST, PATCH, DELETE } from './sessions/route'
import { GET as getRequest, POST as updateRequest } from './requests/route'

const routes = [
  { handle: POST, method: 'POST', path: '/api/chat/sessions', body: {} },
  { handle: GET, method: 'GET', path: '/api/chat/sessions?recordId=1' },
  { handle: PATCH, method: 'PATCH', path: '/api/chat/sessions', body: { recordId: '1' } },
  { handle: DELETE, method: 'DELETE', path: '/api/chat/sessions', body: { recordId: '1' } },
  { handle: getRequest, method: 'GET', path: '/api/chat/requests?recordId=1&requestId=r1' },
  { handle: updateRequest, method: 'POST', path: '/api/chat/requests?recordId=1&requestId=r1&action=cancel' },
  { handle: updateRequest, method: 'POST', path: '/api/chat/requests?recordId=1&requestId=r1&action=sync' },
]

for (const token of ['signed+/token==', 'literal%3D-token']) {
  test(`login cookies retain their original token across session and request routes (${token})`, async () => {
    const originalFetch = globalThis.fetch
    const originalBase = process.env.OA_API_BASE_URL
    process.env.OA_API_BASE_URL = 'https://oa.example.test'
    const forwarded: (string | null)[] = []
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/auth/login') {
        return Response.json({ code: 200, success: true, data: { id: 3, email: 'user@example.test', token } })
      }
      const authorization = new Headers(init?.headers).get('authorization')
      forwarded.push(authorization)
      if (authorization !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({ recordId: '1', messages: [] })
    }
    try {
      const response = await login(new Request('http://localhost/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.test', password: 'test-password' }),
      }))
      assert.equal(response.status, 200)
      const cookie = response.headers.get('set-cookie')?.split(';')[0]
      assert.ok(cookie)
      for (const route of routes) {
        const result = await route.handle(new Request(`http://localhost${route.path}`, {
          method: route.method,
          headers: { cookie: `unrelated=1; ${cookie}`, 'Content-Type': 'application/json' },
          body: route.body === undefined ? undefined : JSON.stringify(route.body),
        }))
        assert.ok(result.ok, `${route.method} ${route.path} returned ${result.status}`)
      }
      assert.deepEqual(forwarded, routes.map(() => `Bearer ${token}`))
    } finally {
      globalThis.fetch = originalFetch
      if (originalBase === undefined) delete process.env.OA_API_BASE_URL
      else process.env.OA_API_BASE_URL = originalBase
    }
  })
}

test('missing, empty and malformed session cookies never reach the Agent', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  try {
    for (const cookie of ['', 'sessionid=', 'sessionid=broken%ZZ']) {
      for (const route of routes) {
        const response = await route.handle(new Request(`http://localhost${route.path}`, {
          method: route.method, headers: { cookie, 'Content-Type': 'application/json' },
          body: route.body === undefined ? undefined : JSON.stringify(route.body),
        }))
        assert.equal(response.status, 401)
      }
    }
    assert.equal(calls, 0)
  } finally { globalThis.fetch = originalFetch }
})
