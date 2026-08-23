export type KnowledgeBaseSource = {
  title: string;
  description: string;
  originalContent: string;
  sourceUrl: string;
};

type RankedKnowledgeBaseSource = KnowledgeBaseSource & {
  descriptionRank: number;
};

const MAX_DESCRIPTION_LENGTH = 180;
const activeSources = new Map<
  string,
  Map<string, RankedKnowledgeBaseSource>
>();

export function beginKnowledgeBaseSourceTurn(sessionId: string): void {
  activeSources.set(sessionId, new Map());
}

export function recordKnowledgeBaseSourceResult(
  sessionId: string,
  result: unknown,
): void {
  const sources = activeSources.get(sessionId);
  const response = toRecord(result);
  if (!sources || !response || response.ok !== true) {
    return;
  }

  for (const source of extractKnowledgeBaseSources(response.data)) {
    const existing = sources.get(source.sourceUrl);
    if (
      !existing ||
      source.descriptionRank > existing.descriptionRank ||
      (source.descriptionRank === existing.descriptionRank &&
        source.originalContent.length > existing.originalContent.length)
    ) {
      sources.set(source.sourceUrl, source);
    }
  }
}

export function finishKnowledgeBaseSourceTurn(
  sessionId: string,
): KnowledgeBaseSource[] {
  const sources = activeSources.get(sessionId);
  activeSources.delete(sessionId);
  if (!sources) {
    return [];
  }

  return [...sources.values()].map(
    ({ title, description, originalContent, sourceUrl }) => ({
      title,
      description,
      originalContent,
      sourceUrl,
    }),
  );
}

function extractKnowledgeBaseSources(value: unknown): RankedKnowledgeBaseSource[] {
  const sources: RankedKnowledgeBaseSource[] = [];
  visitSourceValues(value, sources, 0);
  return sources;
}

function visitSourceValues(
  value: unknown,
  sources: RankedKnowledgeBaseSource[],
  depth: number,
): void {
  if (depth > 10) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visitSourceValues(item, sources, depth + 1));
    return;
  }

  const record = toRecord(value);
  if (!record) {
    return;
  }

  const title = stringValue(record.title);
  const sourceUrl = safeHttpUrl(record.sourceUrl);
  if (title && sourceUrl) {
    const content = extractContentText(record.content);
    const excerpt = stringValue(record.excerpt);
    const rawDescription = content || excerpt || "打开知识库查看完整内容。";
    const originalContent = normalizeDescription(rawDescription);
    sources.push({
      title,
      description: truncateDescription(originalContent),
      originalContent,
      sourceUrl,
      descriptionRank: content ? 2 : excerpt ? 1 : 0,
    });
  }

  Object.values(record).forEach((item) =>
    visitSourceValues(item, sources, depth + 1),
  );
}

function extractContentText(value: unknown): string | null {
  if (typeof value === "string") {
    return stringValue(value);
  }
  const textSegments: string[] = [];
  collectTextSegments(value, textSegments, 0);
  return stringValue(textSegments.join(" "));
}

function collectTextSegments(
  value: unknown,
  segments: string[],
  depth: number,
): void {
  if (depth > 12) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextSegments(item, segments, depth + 1));
    return;
  }
  const record = toRecord(value);
  if (!record) {
    return;
  }
  const text = stringValue(record.text);
  if (text) {
    segments.push(text);
  }
  Object.entries(record).forEach(([key, item]) => {
    if (key !== "text") {
      collectTextSegments(item, segments, depth + 1);
    }
  });
}

function normalizeDescription(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+[^\n]*(?:\n+|$)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+>])\s+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateDescription(value: string): string {
  const characters = Array.from(value || "打开知识库查看完整内容。");
  if (characters.length <= MAX_DESCRIPTION_LENGTH) {
    return characters.join("");
  }
  return `${characters
    .slice(0, MAX_DESCRIPTION_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

function safeHttpUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) {
    return null;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
