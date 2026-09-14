import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAgentHttpServer } from '../../../../agent/src/api/httpServer'
import { SessionStore } from '../../../../agent/src/infrastructure/persistence/sessionStore'
import { ChatLatencyMetricsRecorder } from '../../../../agent/src/infrastructure/observability/chatLatency'
import type { AgentService } from '../../../../agent/src/application/agentService'
import type { AppConfig } from '../../../../agent/src/config/config'
import * as sessions from './sessions/route'
import * as requests from './requests/route'
import { POST as chat } from './route'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

test('Web proxies resolve root .env and exercise a real HTTP Agent through OA create, SSE, replay, query and history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-agent-env-'))
  const oldCwd = process.cwd()
  const names = ['AGENT_API_BASE_URL','AGENT_BASE_URL','NEXT_PUBLIC_AGENT_API_BASE_URL']
  const saved = new Map(names.map(name => [name, process.env[name]]))
  const records = new Map<string, any>()
  let count = 0, modelCalls = 0
  const oa = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://oa')
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); res.end('{}'); return }
    if (url.pathname === '/user/user') { res.end(JSON.stringify({ data: { user_id: 1, email: 'test@example.test' } })); return }
    if (url.pathname === '/copilot/list') { res.end(JSON.stringify({ data: { items: [...records.values()], total: records.size } })); return }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    const id = url.searchParams.get('record_id') || String(++count)
    if (req.method === 'POST') records.set(id, { id, user_id: 1, record: JSON.parse(body), created_at: 1720000000, updated_at: 1720000000 })
    if (req.method === 'PATCH') records.get(id).record = JSON.parse(body)
    res.end(JSON.stringify({ data: records.get(id) }))
  })
  const oaBase = await listen(oa)
  const storePath = path.join(directory, 'sessions.json')
  const config = { sessionStorePath: storePath, oaApiBaseUrl: oaBase, oaAuthAlias: 'default', oaUserTokenHeader: 'Authorization', oaUserTokenPrefix: 'Bearer', modelProvider: 'nexttoken', model: 'gpt-5.6-terra' } as AppConfig
  const service = { async streamMessage(input: any, emit: any) {
    modelCalls++
    await emit({ type: 'message.delta', sessionId: input.sessionId, itemId: 'answer', delta: 'AI_OK', text: 'AI_OK' })
    await emit({ type: 'run.completed', sessionId: input.sessionId, result: { sessionId: input.sessionId, threadId: 'internal', provider: input.provider, model: input.model, finalResponse: 'AI_OK', knowledgeSources: [] } })
  } } as AgentService
  const agent = createAgentHttpServer(config, service, new SessionStore(storePath), undefined, new ChatLatencyMetricsRecorder({ logger: () => {} }))
  const agentBase = await listen(agent)
  const request = (pathname: string, method = 'GET', body?: unknown) => new Request(`http://web.test${pathname}`, { method,
    headers: { Cookie: 'sessionid=test-token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  try {
    await mkdir(path.join(directory, 'frontend'))
    await writeFile(path.join(directory, '.env'), `AGENT_API_BASE_URL=${agentBase}\n`)
    for (const name of names) delete process.env[name]
    process.chdir(path.join(directory, 'frontend'))
    const created = await sessions.POST(request('/api/chat/sessions', 'POST', {}))
    assert.equal(created.status, 201)
    const recordId = (await created.json()).session.recordId
    assert.equal(recordId, '1')
    const payload = { recordId, requestId: 'first', messages: [{ role: 'user', content: 'hello' }] }
    const response = await chat(request('/api/chat', 'POST', payload))
    assert.equal(response.status, 200)
    assert.match(await response.text(), /AI_OK/)
    const query = await requests.GET(request(`/api/chat/requests?recordId=${recordId}&requestId=first`))
    assert.equal(query.status, 200)
    const value = await query.json()
    assert.equal(value.state, 'completed'); assert.equal(value.historySync, 'synced')
    assert.equal(value.result.finalResponse, 'AI_OK')
    const replay = await chat(request('/api/chat', 'POST', payload))
    assert.match(await replay.text(), /AI_OK/); assert.equal(modelCalls, 1)
    const history = await sessions.GET(request(`/api/chat/sessions?recordId=${recordId}`))
    const messages = (await history.json()).session.messages
    assert.equal(messages.length, 2); assert.equal(messages[1].content, 'AI_OK')
    const listed = await sessions.GET(request('/api/chat/sessions'))
    assert.equal((await listed.json()).sessions[0].recordId, recordId)
    const second = await chat(request('/api/chat', 'POST', { ...payload, requestId: 'second' }))
    assert.match(await second.text(), /AI_OK/); assert.equal(modelCalls, 2)
    assert.equal(records.get(recordId).record.messages.length, 4)
    const ordinary = await fetch(`${agentBase}/v1/sessions/${recordId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'ordinary' },
      body: JSON.stringify({ message: 'ordinary response' }),
    })
    assert.equal(ordinary.status, 200)
    assert.equal((await ordinary.json()).result.finalResponse, 'AI_OK')
    assert.equal(modelCalls, 3)
    assert.equal(records.get(recordId).record.messages.length, 6)

  } finally {
    process.chdir(oldCwd)
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    agent.closeAllConnections(); oa.closeAllConnections()
    await Promise.all([new Promise<void>(r => agent.close(() => r())), new Promise<void>(r => oa.close(() => r()))])
    await rm(directory, { recursive: true, force: true })
  }
})
