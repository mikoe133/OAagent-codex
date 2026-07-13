type MessageListOverflowInput = {
  messageCount: number
  isStreaming: boolean
  hasError: boolean
}

export function resolveMessageListOverflow({
  messageCount,
  isStreaming,
  hasError,
}: MessageListOverflowInput): "overflow-hidden" | "overflow-y-auto" {
  return messageCount === 0 && !isStreaming && !hasError ? "overflow-hidden" : "overflow-y-auto"
}
