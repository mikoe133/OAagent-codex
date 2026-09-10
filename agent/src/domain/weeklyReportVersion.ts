/** Legacy numeric versions remain accepted; large versions should travel as decimal strings. */
export type WeeklyReportVersion = number | string;
const MAX_VERSION = 9223372036854775807n;
export function isWeeklyReportVersion(value: unknown): value is WeeklyReportVersion {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && BigInt(String(value)) <= MAX_VERSION;
  }
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) &&
    value.length <= 19 && BigInt(String(value)) <= MAX_VERSION;
}
export function normalizeWeeklyReportVersion(value: unknown): WeeklyReportVersion {
  if (!isWeeklyReportVersion(value)) throw new Error("周报版本号必须是正整数或 BIGINT 范围内的十进制整数字符串。");
  // Match the decimal representation already used by JSON.stringify for legacy numbers.
  const integer = BigInt(String(value));
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
export function compareWeeklyReportVersions(left: WeeklyReportVersion, right: WeeklyReportVersion): number {
  const a = BigInt(normalizeWeeklyReportVersion(left));
  const b = BigInt(normalizeWeeklyReportVersion(right));
  return a < b ? -1 : a > b ? 1 : 0;
}
