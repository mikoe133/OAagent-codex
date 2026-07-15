export type SessionItemIdentity = {
  sessionId?: string
  recordId?: string | number
}

type SessionCreatedAt = {
  createdAt?: string
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
        return left.index - right.index
      }
      return right.timestamp - left.timestamp
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
