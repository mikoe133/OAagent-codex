import type { Message } from "./chat-shell"

export const LEGACY_MESSAGE_RETRY_HINT = "这条历史消息不支持重试，请在输入框重新发送。若涉及提交、审批等操作，请先核对 OA 中的执行结果。"

export function resolveMessageRetry(messages: Message[]) {
  const message = [...messages].reverse().find((item) => item.role === "user")
  if (!message) return { target: null, hint: undefined }

  const requestId = message.id.endsWith(":user") ? message.id.slice(0, -5) : ""
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(requestId)) {
    return { target: null, hint: LEGACY_MESSAGE_RETRY_HINT }
  }

  return { target: { message, requestId }, hint: undefined }
}
