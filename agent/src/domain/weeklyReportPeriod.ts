export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function weeklyReportPeriod(start: unknown, end: unknown): { startDate: string; endDate: string } | null {
  if (start === undefined && end === undefined) return null;
  if (!isBusinessDate(start) || !isBusinessDate(end) || start > end) {
    throw new Error("周报 start_date/end_date 必须成对提供有效的 YYYY-MM-DD 日期，且开始日期不能晚于结束日期。");
  }
  return { startDate: start, endDate: end };
}
