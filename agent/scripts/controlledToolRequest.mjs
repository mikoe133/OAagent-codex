/** The internal POST may execute writes. Retry decisions belong to the authenticated service. */
export async function postControlledTool(url, token, payload) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (response.ok && data && typeof data === 'object' && typeof data.ok === 'boolean') return data;
    if (!response.ok && data?.ok === false && data.error?.recovery) return data;
    const authenticate = response.status === 401;
    const forbidden = response.status === 403;
    return { ok: false, status: response.status, error: {
      code: authenticate ? 'session_required' : forbidden ? 'tool_forbidden' : 'tool_transport_failed',
      message: `受控工具通信未成功（HTTP ${response.status}）。`,
      recovery: {
        category: authenticate ? 'authentication' : forbidden ? 'permission' : 'execution',
        action: authenticate ? 'authenticate' : 'stop_for_turn', retryable: false,
        instruction: authenticate ? '请用户重新登录后继续，不要猜测身份或读取凭据。'
          : '本轮停止这一请求；保留业务条件，说明已知结果与缺口。写操作结果不确定时先核验，不能直接重发。',
      },
    } };
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
    return { ok: false, error: {
      code: timeout ? 'request_timeout' : 'tool_transport_failed',
      message: timeout ? '受控工具通信超时。' : '受控工具通信未成功。',
      recovery: {
        category: 'transient', action: 'stop_for_turn', retryable: true,
        instruction: '本轮停止这一请求；不要重复相同参数、修改业务范围或 sleep 轮询。写操作结果不确定时先核验，不能直接重发。',
      },
    } };
  }
}

export const toolResultExitCode = result => result?.ok === false && result.error?.code !== 'confirmation_required' ? 1 : 0;
