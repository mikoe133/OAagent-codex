/**
 * Node 24 readline treats U+2028/U+2029 as record boundaries. Normalize them
 * before a tool result can be embedded in the Codex CLI's LF-delimited JSON.
 */
export function normalizeJsonLineSeparators(value: string): string {
  return value.replace(/[\u2028\u2029]/gu, "\n");
}
