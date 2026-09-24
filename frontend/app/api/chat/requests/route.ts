import { getAgentApiBaseUrl } from "@/lib/server/agent-api"
import { readSessionToken } from '@/lib/server/session-cookie'
export const runtime = 'nodejs'
async function handle(request: Request) {
  const token = readSessionToken(request)
  if (!token) return Response.json({ error: 'Authentication required' }, { status: 401 })
  const query = new URL(request.url).searchParams
  const recordId = query.get('recordId') || '', requestId = query.get('requestId') || '', action = query.get('action')
  if (!/^[1-9]\d*$/.test(recordId) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(requestId) || (action && !['cancel','sync'].includes(action)))
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  try {
    const url = new URL(`/v1/sessions/${recordId}/requests/${requestId}${action ? `/${action}` : ''}`, getAgentApiBaseUrl())
    const response = await fetch(url, { method: request.method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: request.signal })
    return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'Agent unavailable' }, { status: 503 }) }
}
export const GET = handle
export const POST = handle
