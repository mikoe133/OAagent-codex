/**
 * JSON.stringify leaves U+2028/U+2029 as literal characters. Node 24's
 * readline treats those characters as record separators, which can split a
 * valid Codex JSONL event before the SDK parses it. Keep the JSON semantics
 * intact while ensuring command stdout cannot contain those separators.
 */
export function stringifyJsonLineSafe(value, space) {
  const serialized = JSON.stringify(value, null, space);
  return (serialized ?? "null")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
