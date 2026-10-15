export function resolveLoadedSessionMessages<T extends { id?: unknown; durationMs?: unknown; toolSteps?: unknown; traceMessages?: unknown }>(
  cachedMessages: T[] | undefined,
  persistedMessages: T[],
  hasUnsyncedWork: boolean,
): T[] {
  if (cachedMessages && (hasUnsyncedWork || cachedMessages.length > 0)) {
    if (!hasUnsyncedWork) {
      const persisted = new Map(persistedMessages
        .filter(message => message.id)
        .map(message => [message.id, message]))
      let changed = false
      const reconciled = cachedMessages.map(message => {
        const stored = persisted.get(message.id)
        if (!stored) return message
        if (Array.isArray(stored.toolSteps) || Array.isArray(stored.traceMessages)) {
          changed = true
          return stored
        }
        if (message.durationMs !== stored.durationMs) {
          changed = true
          return { ...message, durationMs: stored.durationMs }
        }
        return message
      })
      if (changed) return reconciled
    }
    return cachedMessages
  }

  return persistedMessages
}
