export function resolveLoadedSessionMessages<T>(
  cachedMessages: T[] | undefined,
  persistedMessages: T[],
  hasUnsyncedWork: boolean,
): T[] {
  if (cachedMessages && (hasUnsyncedWork || cachedMessages.length > 0)) {
    return cachedMessages
  }

  return persistedMessages
}
