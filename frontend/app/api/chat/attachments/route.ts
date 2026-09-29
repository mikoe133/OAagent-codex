import { getAgentApiBaseUrl } from '@/lib/server/agent-api'
import { readSessionToken } from '@/lib/server/session-cookie'

export const runtime = 'nodejs'
const json = (error: string, status: number) => Response.json({ error }, { status })
async function handle(request: Request) {
  const token = readSessionToken(request)
  if (!token) return json('请先登录', 401)
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  // Next standalone may expose an internal URL behind TLS termination. The
  // deployment proxy preserves Host and overwrites X-Forwarded-Proto.
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)
  const expectedOrigin = `${protocol}://${request.headers.get('host') || url.host}`
  if ((origin && origin !== expectedOrigin) || request.headers.get('sec-fetch-site') === 'cross-site') return json('不允许跨站附件请求', 403)
  const recordId = url.searchParams.get('recordId'), id = url.searchParams.get('id')
  if (!recordId || !/^[1-9]\d*$/.test(recordId) || (id !== null && !/^[a-f0-9-]{36}$/.test(id))) return json('附件参数无效', 400)
  if (request.method === 'GET' && !id) return json('缺少附件编号', 400)
  if (request.method === 'POST' && id) return json('不能覆盖附件', 400)
  if (Number(request.headers.get('content-length')) > 50 * 1024 * 1024) return json('文件限 50 MB', 413)
  try {
    const headers = new Headers({ Authorization: `Bearer ${token}` })
    if (request.method === 'POST') {
      headers.set('content-type', 'application/octet-stream')
      headers.set('x-file-name', request.headers.get('x-file-name') || '')
      const length = request.headers.get('content-length')
      if (length) headers.set('content-length', length)
    }
    const response = await fetch(new URL(`/v1/sessions/${recordId}/attachments${id ? `/${id}` : ''}`, getAgentApiBaseUrl()), {
      method: request.method, headers, body: request.method === 'POST' ? request.body : undefined,
      duplex: 'half', signal: request.signal, cache: 'no-store', redirect: 'error',
    } as RequestInit & { duplex: 'half' })
    const output = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" })
    for (const name of ['content-type', 'content-disposition', 'content-length', 'retry-after']) {
      const value = response.headers.get(name)
      if (value) output.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: output })
  } catch { return json('附件服务暂不可用，请保留文件并重试', 502) }
}
export const POST = handle
export const GET = handle
