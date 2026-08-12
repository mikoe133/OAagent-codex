export function normalizeResponseDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  return Math.round(value)
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
