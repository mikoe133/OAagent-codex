import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { NextRequest } from 'next/server'
import { POST as createSession } from '../app/api/chat/sessions/route'
import { POST as sendMessage } from '../app/api/chat/route'
import { GET as currentUser } from '../app/api/auth/me/route'
import { CHAT_DIAGNOSTICS_KEY, TRACE_HEADER, SOURCE_HEADER, fetchChatWithDiagnostics,
  logChatDiagnostic, redirectToChatLogin, traceId } from './chat-diagnostics'

const id = '11111111-2222-4333-8444-555555555555'

test('generates correlation IDs on HTTP sites without crypto.randomUUID', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })
  assert.match(traceId(), /^[a-f0-9-]{36}$/)
  assert.equal(traceId(id), id)
})

function capture(t: TestContext) {
  const lines: string[] = []
  const info = console.info, warn = console.warn, fetch = globalThis.fetch
  console.info = console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
  t.after(() => { console.info = info; console.warn = warn; globalThis.fetch = fetch })
  return lines
}

function browser(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const entries = new Map<string, string>()
  const redirects: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    sessionStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value) },
    },
    location: { assign: (url: string) => { redirects.push(url) } },
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { entries, redirects }
}

test('correlates an Agent 401 with browser diagnostics and the login redirect without logging secrets', async t => {
  const lines = capture(t)
  const { entries, redirects } = browser(t)
  globalThis.fetch = async (input, init) => {
    if (input === '/api/chat/sessions') {
      return createSession(new Request('http://localhost/api/chat/sessions', {
        ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: 'sessionid=private-token' },
      }))
    }
    return Response.json({ error: 'private-upstream-body', token: 'private-token' }, { status: 401 })
  }
  const response = await fetchChatWithDiagnostics('/api/chat/sessions', {
    method: 'POST', headers: { [TRACE_HEADER]: id }, body: JSON.stringify({ title: 'private-chat-title' }),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get(TRACE_HEADER), id)
  assert.equal(response.headers.get(SOURCE_HEADER), 'agent')
  redirectToChatLogin(response, '/api/chat/sessions')
  assert.deepEqual(redirects, ['/login?next=%2Fchat'])
  const logs = lines.join('\n')
  assert.match(logs, /"scope":"web"/)
  assert.match(logs, /"scope":"browser"/)
  assert.match(logs, /"event":"upstream_response"/)
  assert.match(logs, /"event":"login_redirect"/)
  assert.ok(lines.every(line => line.includes(id)))
  assert.doesNotMatch(logs + entries.get(CHAT_DIAGNOSTICS_KEY), /private-|sessionid|Authorization/)
  // Logging must not consume or alter an error response needed by the UI.
  assert.equal((await response.json()).error, 'private-upstream-body')
})

test('distinguishes a missing cookie locally and rejects untrusted trace IDs', async t => {
  const lines = capture(t)
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not be called') }
  const response = await createSession(new Request('http://localhost/api/chat/sessions', {
    method: 'POST', headers: { [TRACE_HEADER]: 'private-malicious-id' },
  }))
  assert.equal(calls, 0)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get(SOURCE_HEADER), 'local')
  assert.match(response.headers.get(TRACE_HEADER) || '', /^[a-f0-9-]{36}$/)
  assert.doesNotMatch(lines.join('\n'), /private-malicious-id/)
})

test('records network failures without exception messages or URLs and preserves the error', async t => {
  const lines = capture(t)
  browser(t)
  const failure = new Error('private-token https://private-host/path?password=private-password')
  globalThis.fetch = async () => { throw failure }
  await assert.rejects(fetchChatWithDiagnostics('/api/chat/requests?recordId=1&requestId=private-input'), error => error === failure)
  assert.match(lines.join('\n'), /network_failed/)
  assert.doesNotMatch(lines.join('\n'), /private-|password|recordId=/)
})

test('classifies intentional cancellation separately from network failure', async t => {
  const lines = capture(t)
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError') }
  await assert.rejects(fetchChatWithDiagnostics('/api/chat', { signal: controller.signal }))
  assert.match(lines.join('\n'), /"event":"aborted"/)
  assert.doesNotMatch(lines.join('\n'), /network_failed/)
})

test('bounds persisted diagnostics and survives corrupt or unavailable browser storage', async t => {
  capture(t)
  const { entries } = browser(t)
  entries.set(CHAT_DIAGNOSTICS_KEY, 'not JSON')
  for (let index = 0; index < 105; index++) {
    logChatDiagnostic({ scope: 'browser', route: '/api/chat', traceId: id, event: 'request_started' })
  }
  assert.equal(JSON.parse(entries.get(CHAT_DIAGNOSTICS_KEY)!).length, 100)
  window.sessionStorage.setItem = () => { throw new Error('storage disabled') }
  console.info = () => { throw new Error('console unavailable') }
  globalThis.fetch = async () => new Response('unchanged')
  assert.equal(await (await fetchChatWithDiagnostics('/api/chat')).text(), 'unchanged')
})

test('records OA identity validation failures separately from local cookie failures', async t => {
  const lines = capture(t)
  const previous = process.env.OA_API_BASE_URL
  process.env.OA_API_BASE_URL = 'https://oa.example.test'
  t.after(() => {
    if (previous === undefined) delete process.env.OA_API_BASE_URL
    else process.env.OA_API_BASE_URL = previous
  })
  globalThis.fetch = async () => Response.json({ success: false }, { status: 401 })
  const response = await currentUser(new NextRequest('http://localhost/api/auth/me', {
    headers: { cookie: 'sessionid=private-token', [TRACE_HEADER]: id },
  }))
  assert.equal(response.headers.get(SOURCE_HEADER), 'oa_auth')
  assert.match(lines.join('\n'), /"phase":"oa_auth"/)
  assert.doesNotMatch(lines.join('\n'), /private-token/)
})

for (const [stream, event] of [
  ['data: {"type":"run.completed","result":{"finalResponse":"private-answer"}}\n\n', 'stream_completed'],
  ['data: {"type":"run.failed","error":"private-upstream-error"}\n\n', 'stream_failed'],
  ['data: {"type":"message.delta","delta":"private-answer"}\n\n', 'stream_incomplete'],
]) {
  test(`records ${event} after HTTP 200 without consuming or logging chat content`, async t => {
    const lines = capture(t)
    globalThis.fetch = async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    const response = await sendMessage(new Request('http://localhost/api/chat', {
      method: 'POST', headers: { cookie: 'sessionid=private-token', [TRACE_HEADER]: id },
      body: JSON.stringify({ recordId: '1', requestId: 'request-1', messages: [{ role: 'user', content: 'private-question' }] }),
    }))
    assert.equal(response.status, 200)
    const output = await response.text()
    assert.match(output, /private-/)
    assert.ok(lines.some(line => line.includes(`"event":"${event}"`)))
    assert.doesNotMatch(lines.join('\n'), /private-/)
  })
}
