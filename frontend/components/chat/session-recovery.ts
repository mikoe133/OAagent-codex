export const SESSION_UNAVAILABLE_MESSAGE = "当前会话已失效或不属于当前账号。请从左侧重新打开会话，或新建对话后发送。"

export class SessionUnavailableError extends Error {
  constructor() {
    super(SESSION_UNAVAILABLE_MESSAGE)
  }
}

export async function prepareChatSession(input: {
  sessionId: string
  hasMessages: boolean
  load: () => Promise<unknown>
  create: () => Promise<string>
}): Promise<string> {
  if (/^[1-9]\d*$/.test(input.sessionId)) {
    try {
      await input.load()
      return input.sessionId
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error
      if (input.hasMessages) throw error
    }
  } else if (input.hasMessages) {
    throw new SessionUnavailableError()
  }
  return input.create()
}
