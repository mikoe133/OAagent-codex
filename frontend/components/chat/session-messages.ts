export function resolveLoadedSessionMessages<T extends { id?: unknown; durationMs?: unknown; toolSteps?: unknown; traceMessages?: unknown }>(
  cachedMessages: T[] | undefined,
  persistedMessages: T[],
  hasUnsyncedWork: boolean,
): T[] {
  if (cachedMessages && hasUnsyncedWork) return cachedMessages
  if (!cachedMessages?.length) return persistedMessages
  if (!persistedMessages.length) return cachedMessages

  const cached = new Map(cachedMessages.filter(message => message.id).map(message => [message.id, message]))
  const persistedIds = new Set(persistedMessages.filter(message => message.id).map(message => message.id))

  // Include messages sent on other devices in server order, while retaining local-only work.
  const reconciled = persistedMessages.map(stored => {
    const message = stored.id ? cached.get(stored.id) : undefined
    if (!message || Array.isArray(stored.toolSteps) || Array.isArray(stored.traceMessages)) return stored
    if (message.durationMs !== stored.durationMs) return { ...message, durationMs: stored.durationMs }
    return message
  })
  reconciled.push(...cachedMessages.filter(message => !message.id || !persistedIds.has(message.id)))

  return reconciled.length === cachedMessages.length && reconciled.every((message, index) => message === cachedMessages[index])
    ? cachedMessages
    : reconciled
}
