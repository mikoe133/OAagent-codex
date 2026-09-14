import assert from 'node:assert/strict'
import test from 'node:test'
import { GET, POST, PATCH, DELETE } from './route'

test('Web sessions proxy uses OA IDs and never writes generated history', async () => {
  const old = globalThis.fetch
  const calls: { url: URL; init?: RequestInit }[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init })
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token')
    if (url.search) return Response.json({ sessions: [{ recordId: '2', createdAt: 200 }, { recordId: '1', createdAt: 100 }], total: 2 })
    return Response.json({ recordId: '1', messages: [{ id: 'r:assistant', content: 'server answer' }], createdAt: 100 })
  }
  const request = (method: string, body?: unknown, query = '') => new Request(`http://localhost/api/chat/sessions${query}`, {
    method, headers: { cookie: 'sessionid=token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  try {
    const created = await (await POST(request('POST', { sessionId: 'browser-draft' }))).json()
    assert.equal(created.session.sessionId, '1'); assert.equal(created.session.recordId, '1')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {})
    const list = await (await GET(request('GET'))).json()
    assert.deepEqual(list.sessions.map((s: any) => s.recordId), ['2', '1'])
    await PATCH(request('PATCH', { recordId: '1', messages: [{ id: 'r:assistant', content: 'stale browser answer', feedback: 'like' }] }))
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { feedback: { 'r:assistant': 'like' } })
    await DELETE(request('DELETE', { recordId: '1' }))
    assert.equal(calls.at(-1)?.url.pathname, '/v1/sessions/1')
    assert.equal(calls.at(-1)?.init?.method, 'DELETE')
    assert.equal((await GET(request('GET', undefined, '?recordId=old-agent-id'))).status, 400)
    assert.ok(calls.every(call => !call.url.pathname.startsWith('/copilot')))
    assert.equal((await GET(new Request('http://localhost/api/chat/sessions'))).status, 401)
  } finally { globalThis.fetch = old }
})
