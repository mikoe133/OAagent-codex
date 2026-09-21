export function resolveLoadedSessionMessages<T extends { id?: unknown; toolSteps?: unknown; traceMessages?: unknown }>(
  cachedMessages: T[] | undefined,
  persistedMessages: T[],
  hasUnsyncedWork: boolean,
): T[] {
  if (cachedMessages && (hasUnsyncedWork || cachedMessages.length > 0)) {
    if (!hasUnsyncedWork) {
      const traced = new Map(persistedMessages
        .filter(message => message.id && (Array.isArray(message.toolSteps) || Array.isArray(message.traceMessages)))
        .map(message => [message.id, message]))
      if (traced.size) return cachedMessages.map(message => traced.get(message.id) ?? message)
    }
    return cachedMessages
  }

  return persistedMessages
}
