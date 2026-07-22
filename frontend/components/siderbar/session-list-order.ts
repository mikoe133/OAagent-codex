export type SessionItemIdentity = {
  sessionId?: string
  recordId?: string | number
}

type SessionCreatedAt = {
  createdAt?: string
  sessionId?: string
}

type SessionIdentity = {
  sessionId: string
  recordId?: string | number | null
}

export function matchesSessionIdentity(item: SessionItemIdentity, identity: SessionIdentity): boolean {
  if (item.sessionId !== identity.sessionId) {
    return false
  }

  const targetRecordId = normalizeRecordId(identity.recordId)
  return targetRecordId === null || normalizeRecordId(item.recordId) === targetRecordId
}

export function resolveStableSessionOrder<T extends SessionCreatedAt>(items: T[], _activeSessionId?: string): T[] {
  return sortSessionItemsByCreatedAt(items)
}

export function sortSessionItemsByCreatedAt<T extends SessionCreatedAt>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, timestamp: parseCreatedAt(item.createdAt) }))
    .sort((left, right) => {
      if (left.timestamp === right.timestamp) {
        const identityOrder = (left.item.sessionId || "").localeCompare(right.item.sessionId || "")
        return identityOrder || left.index - right.index
      }
      return right.timestamp - left.timestamp
    })
    .map(({ item }) => item)
}

export function sortSessionItemsByPinnedOrder<T extends SessionItemIdentity>(
  items: T[],
  pinnedSessionIds: readonly string[],
): T[] {
  const pinnedOrder = new Map<string, number>()
  pinnedSessionIds.forEach((sessionId, index) => {
    if (!pinnedOrder.has(sessionId)) {
      pinnedOrder.set(sessionId, index)
    }
  })

  return items
    .map((item, index) => ({
      item,
      index,
      pinnedIndex: item.sessionId ? pinnedOrder.get(item.sessionId) : undefined,
    }))
    .sort((left, right) => {
      const leftIsPinned = left.pinnedIndex !== undefined
      const rightIsPinned = right.pinnedIndex !== undefined

      if (left.pinnedIndex !== undefined && right.pinnedIndex !== undefined) {
        return left.pinnedIndex - right.pinnedIndex
      }
      if (leftIsPinned) {
        return -1
      }
      if (rightIsPinned) {
        return 1
      }
      return left.index - right.index
    })
    .map(({ item }) => item)
}

function normalizeRecordId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }

  const normalized = String(value).trim()
  return normalized || null
}

function parseCreatedAt(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}
