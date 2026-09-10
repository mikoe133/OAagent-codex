import { weeklyReportPeriod } from "../domain/weeklyReportPeriod.js";
import { compareWeeklyReportVersions, isWeeklyReportVersion, normalizeWeeklyReportVersion } from "../domain/weeklyReportVersion.js";
import type { WeeklyReportSnapshot } from "./weeklyReportProjectSummarySync.js";

export async function resolveWeeklyReportSource(
  snapshot: Record<string, unknown> | null,
  readReport: (id: string) => Promise<WeeklyReportSnapshot>,
): Promise<WeeklyReportSnapshot> {
  if (!snapshot || typeof snapshot.source_report_id !== "string") {
    throw new Error("事件缺少可读取的周报源快照。");
  }
  const period = weeklyReportPeriod(snapshot.start_date, snapshot.end_date);
  if (isWeeklyReportVersion(snapshot.source_version) &&
    typeof snapshot.weekly_num === "number" &&
    typeof snapshot.updated_at === "string" && typeof snapshot.content === "string") {
    return {
      id: snapshot.source_report_id,
      weeklyNum: snapshot.weekly_num,
      content: snapshot.content,
      version: normalizeWeeklyReportVersion(snapshot.source_version),
      updatedAt: snapshot.updated_at,
      ownerId: null,
      ...(period ?? {}),
    };
  }
  const current = await readReport(snapshot.source_report_id);
  if (!isWeeklyReportVersion(snapshot.source_version) ||
    compareWeeklyReportVersions(current.version, snapshot.source_version) !== 0) {
    throw new Error(`周报源版本已推进:${snapshot.source_version}->${current.version}`);
  }
  return { ...current, ...(period ?? {}) };
}
