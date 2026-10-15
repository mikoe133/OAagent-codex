export function normalizeResponseDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  return Math.round(value)
}

/** Only server timing may be displayed; missing timing stays unknown. */
export function serverResponseDurationMs(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const duration = normalizeResponseDuration(record.durationMs)
  if (duration !== undefined) return duration
  if (record.result && typeof record.result === "object") {
    const resultDuration = normalizeResponseDuration((record.result as Record<string, unknown>).durationMs)
    if (resultDuration !== undefined) return resultDuration
  }
  if (!["completed", "failed", "cancelled"].includes(String(record.state)) ||
    typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return undefined
  const elapsed = Date.parse(record.updatedAt) - Date.parse(record.createdAt)
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined
}

export function calculateResponseDurationMs(startedAt: number, completedAt: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return 0
  }

  return Math.max(0, Math.round(completedAt - startedAt))
}

export function formatResponseDuration(value: unknown): string | null {
  const durationMs = normalizeResponseDuration(value)
  if (durationMs === undefined) {
    return null
  }

  if (durationMs < 1_000) {
    return `${durationMs} 毫秒`
  }

  const seconds = (durationMs / 1_000).toFixed(1).replace(/\.0$/, "")
  return `${seconds} 秒`
}
