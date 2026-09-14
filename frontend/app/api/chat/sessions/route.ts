import { getAgentApiBaseUrl } from "@/lib/server/agent-api"
import { SESSION_COOKIE_NAME } from '@/lib/auth'

export const runtime = 'nodejs'
const base = getAgentApiBaseUrl
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
function token(request: Request) {
  return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.slice(SESSION_COOKIE_NAME.length + 1)
}
function normalize(value: any) {
  const timestamp = (input: unknown) => typeof input === 'number' ? new Date(input * 1000).toISOString() : input
  // sessionId is only a UI compatibility alias of the OA ID, never a second ID.
  return { ...value, sessionId: String(value.recordId), recordId: String(value.recordId),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt), summary: value.summary || value.title || 'New Section' }
}
async function handle(request: Request) {
  const credential = token(request)
  if (!credential) return json({ error: 'Authentication required' }, 401)
  try {
    const method = request.method
    const query = new URL(request.url).searchParams
    const body = method === 'GET' ? {} : await request.json()
    const recordId = query.get('recordId') || query.get('sessionId') || body.recordId || body.sessionId
    const call = async (pathname: string, verb = 'GET', payload?: unknown) => {
      const response = await fetch(new URL(pathname, base()), { method: verb,
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload), cache: 'no-store', signal: request.signal })
      if (!response.ok) throw response
      return response.json()
    }
    if (method === 'POST') {
      const session = normalize(await call('/v1/sessions', 'POST', {}))
      return json({ session, sessions: [session] }, 201)
    }
    if (recordId && !/^[1-9]\d*$/.test(String(recordId))) return json({ error: '请从会话列表重新打开旧会话，使用 OA recordId' }, 400)
    if (method === 'GET' && !recordId) {
      const sessions = []
      for (let page = 1; page <= 50; page++) {
        const value = await call(`/v1/sessions?page=${page}&size=100`)
        sessions.push(...value.sessions.map(normalize))
        if (value.sessions.length < 100 || sessions.length >= value.total) {
          sessions.sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)))
          return json({ sessions })
        }
      }
      return json({ error: '会话列表超过页面加载上限' }, 503)
    }
    if (!recordId) return json({ error: 'OA recordId required' }, 400)
    const pathname = `/v1/sessions/${recordId}`
    if (method === 'GET') return json({ session: normalize(await call(pathname)) })
    if (method === 'DELETE') return json(await call(pathname, 'DELETE'))
    if (method === 'PATCH') {
      // The browser owns feedback/title only. Generated messages are written by Agent.
      const feedback = Object.fromEntries((Array.isArray(body.messages) ? body.messages : [])
        .filter((message: any) => ['like','dislike',null].includes(message.feedback))
        .map((message: any) => [message.id, message.feedback]))
      return json({ session: normalize(await call(pathname, 'PATCH', {
        ...(body.title === undefined ? {} : { title: body.title }), feedback,
      })) })
    }
    return json({ error: 'Method not allowed' }, 405)
  } catch (error) {
    if (error instanceof Response) return new Response(await error.text(), { status: error.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    return json({ error: 'Agent session service unavailable' }, 502)
  }
}
export const GET = handle
export const POST = handle
export const PATCH = handle
export const DELETE = handle
