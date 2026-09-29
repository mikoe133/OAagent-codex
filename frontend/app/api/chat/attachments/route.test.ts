import assert from 'node:assert/strict'
import test from 'node:test'
import { POST, GET } from './route'
import { POST as chat } from '../route'

test('attachment proxy requires authentication and prevents cross-site uploads', async () => {
  assert.equal((await POST(new Request('http://localhost/api/chat/attachments?recordId=1', { method: 'POST' }))).status, 401)
  assert.equal((await POST(new Request('http://localhost/api/chat/attachments?recordId=1', { method: 'POST', headers: { cookie: 'sessionid=token', origin: 'https://evil.test' } }))).status, 403)
})

test('attachment proxy streams bytes with session credentials and safe download headers', async () => {
  const original = globalThis.fetch
  let forwarded: RequestInit | undefined
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1\/sessions\/1\/attachments/)
    forwarded = init
    return new Response('hello', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment' } })
  }
  try {
    const response = await POST(new Request('http://localhost/api/chat/attachments?recordId=1', { method: 'POST', headers: { cookie: 'sessionid=token', 'x-file-name': '%E8%AF%B4%E6%98%8E.txt', origin: 'https://oa.example.test', host: 'oa.example.test', 'x-forwarded-proto': 'https' }, body: 'hello' }))
    assert.equal(response.status, 200)
    assert.equal(await new Response(forwarded?.body).text(), 'hello')
    assert.equal(new Headers(forwarded?.headers).get('authorization'), 'Bearer token')
    assert.equal(new Headers(forwarded?.headers).get('x-file-name'), '%E8%AF%B4%E6%98%8E.txt')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-disposition'), 'attachment')
    assert.equal((await GET(new Request('http://localhost/api/chat/attachments?recordId=1&id=../../env', { headers: { cookie: 'sessionid=token' } }))).status, 400)
  } finally { globalThis.fetch = original }
})

test('chat forwards only the latest attachment IDs and rejects malformed attachment lists', async () => {
  const original = globalThis.fetch
  const id = 'b6c470f8-a0b8-46c9-a2d3-1b85f9c9dd33'
  let body: any
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response('event: run.completed\ndata: {"type":"run.completed","result":{"finalResponse":"ok"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  const request = (attachmentIds: unknown) => new Request('http://localhost/api/chat', { method: 'POST', headers: { cookie: 'sessionid=token', 'content-type': 'application/json' }, body: JSON.stringify({ recordId: '1', requestId: 'req-1', attachmentMode: 'upload', attachmentTarget: '研发页面', messages: [{ role: 'user', content: 'old', attachmentIds: ['old'] }, { role: 'user', content: '分析附件', attachmentIds }] }) })
  try {
    const response = await chat(request([id])); await response.text()
    assert.deepEqual(body.attachmentIds, [id]); assert.equal(body.message, '分析附件'); assert.equal(body.attachmentMode, 'upload'); assert.equal(body.attachmentTarget, '研发页面')
    assert.equal((await chat(request(['../../env']))).status, 400)
  } finally { globalThis.fetch = original }
})
