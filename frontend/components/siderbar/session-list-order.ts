export type SessionItemIdentity = {
  sessionId?: string
  recordId?: string | number
}

type SessionPriority = {
  sessionId: string
  recordId?: string | number | null
}

export function matchesSessionIdentity(item: SessionItemIdentity, identity: SessionPriority): boolean {
  if (item.sessionId !== identity.sessionId) {
    return false
  }

  const targetRecordId = normalizeRecordId(identity.recordId)
  return targetRecordId === null || normalizeRecordId(item.recordId) === targetRecordId
}

export function prioritizeSessionItem<T extends SessionItemIdentity>(
  items: T[],
  priority: SessionPriority | null | undefined,
): T[] {
  if (!priority?.sessionId) {
    return items
  }

  const priorityIndex = items.findIndex((item) => matchesSessionIdentity(item, priority))
  if (priorityIndex <= 0) {
    return items
  }

  return [items[priorityIndex], ...items.slice(0, priorityIndex), ...items.slice(priorityIndex + 1)]
}

function normalizeRecordId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }

  const normalized = String(value).trim()
  return normalized || null
}
