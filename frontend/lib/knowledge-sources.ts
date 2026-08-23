export type KnowledgeSource = {
  title: string
  description: string
  originalContent: string
  sourceUrl: string
}

const MAX_DESCRIPTION_LENGTH = 180

export function normalizeKnowledgeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) {
    return []
  }

  const sources = new Map<string, KnowledgeSource>()
  for (const item of value) {
    const source = normalizeKnowledgeSource(item)
    if (!source) {
      continue
    }
    const existing = sources.get(source.sourceUrl)
    if (
      !existing ||
      source.originalContent.length > existing.originalContent.length ||
      (source.originalContent.length === existing.originalContent.length &&
        source.description.length > existing.description.length)
    ) {
      sources.set(source.sourceUrl, source)
    }
  }
  return [...sources.values()]
}

function normalizeKnowledgeSource(value: unknown): KnowledgeSource | null {
  const record = toRecord(value)
  const title = stringValue(record?.title)
  const description = stringValue(record?.description) || "打开知识库查看完整内容。"
  const originalContent = stringValue(record?.originalContent) || description
  const sourceUrl = safeHttpUrl(record?.sourceUrl)
  if (!title || !sourceUrl) {
    return null
  }

  return {
    title,
    description: truncateDescription(description.replace(/\s+/g, " ").trim()),
    originalContent,
    sourceUrl,
  }
}

function truncateDescription(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= MAX_DESCRIPTION_LENGTH) {
    return value
  }
  return `${characters
    .slice(0, MAX_DESCRIPTION_LENGTH - 1)
    .join("")
    .trimEnd()}…`
}

function safeHttpUrl(value: unknown): string | null {
  const candidate = stringValue(value)
  if (!candidate) {
    return null
  }
  try {
    const url = new URL(candidate)
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null
  } catch {
    return null
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
