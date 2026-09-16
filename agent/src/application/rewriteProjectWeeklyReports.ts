import type { WeeklyReportRewriteOa, WeeklyReportRewriteContext } from "../domain/weeklyReportRewrite.js";
import { OaRequestError, ProjectProgressLeaseLostError } from "../infrastructure/oa/projectProgressOaClient.js";
import type { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import type { ProjectProgressProjectReport, ProjectProgressSummaryProposal, ProjectProgressTraceSink } from "./syncProjectProgress.js";
import { type WeeklyReportRewriter } from "./weeklyReportRewriter.js";

export type WeeklyReportRewriteTarget = { projectId: number; summaryDate: string; githubId: string; authorName: string; proposal: ProjectProgressSummaryProposal };

/** Runs only after project facts have been persisted. One complete replacement per author/day, using the current report as the baseline. */
export async function rewriteProjectWeeklyReports(input: {
  targets: WeeklyReportRewriteTarget[]; reports: ProjectProgressProjectReport[];
  oa: WeeklyReportRewriteOa; rewriter: WeeklyReportRewriter;
  agentLimiter: AsyncSemaphore; writeLimiter: AsyncSemaphore;
  trace?: ProjectProgressTraceSink; signal?: AbortSignal; shouldCancel?: () => boolean;
}): Promise<number> {
  let updates = 0;
  const handled = new Set<WeeklyReportRewriteTarget>();
  const ensureActive = () => { input.signal?.throwIfAborted(); if (input.shouldCancel?.()) throw new Error("weekly_report_cancelled"); };
  const reportFor = (target: WeeklyReportRewriteTarget) => input.reports.find((r) => r.projectId === target.projectId)!;
  for (const target of [...input.targets].sort((a, b) => a.summaryDate.localeCompare(b.summaryDate))) {
    if (handled.has(target)) continue;
    const related = input.targets.filter((t) => t.githubId.toLowerCase() === target.githubId.toLowerCase() && t.summaryDate === target.summaryDate);
    const event = { eventKey: `weekly_report_rewrite:${target.githubId.toLowerCase()}:${target.summaryDate}`, sequence: 650, phase: "weekly_report_rewrite", title: "结合当天 Commit 总结重写整篇周报", projectId: target.projectId };
    try {
      ensureActive();
      await input.trace?.({ ...event, status: "running" });
      if (typeof input.oa.getWeeklyReportRewriteContext !== "function" || typeof input.oa.replaceWeeklyReport !== "function") throw new Error("weekly_report_rewrite_api_unavailable");
      let original: WeeklyReportRewriteContext | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        ensureActive();
        const context = await input.oa.getWeeklyReportRewriteContext(target, input.signal);
        if (original && (context.report_id !== original.report_id || context.owner_id !== original.owner_id || context.start_date !== original.start_date || context.end_date !== original.end_date)) throw new Error("weekly_report_target_changed");
        original = context;
        if (related.some((t) => reportFor(t).outcome === "incomplete" || reportFor(t).warnings.some((w) => w.startsWith("write_failed:") || w.startsWith("repository_summary_fallback:")))) throw new Error("weekly_report_daily_summaries_not_ready");
        const summaries = [...new Map(related.map((t) => [t.projectId, {
          source_id: `daily:${t.projectId}:${t.summaryDate}`,
          project_id: t.projectId, project_name: reportFor(t).projectName,
          summary_date: t.summaryDate, content: t.proposal.summary,
        }])).values()];
        const generated = await input.agentLimiter.run(() => input.rewriter.rewrite({ context, summaryDate: target.summaryDate, summaries }, input.signal), input.signal);
        (target.proposal.weeklyReportInteractions ??= []).push({ githubId: target.githubId, interaction: generated.interaction, auditKey: `weekly-report-rewrite:${context.report_id}:${target.summaryDate}:${attempt}` });
        if (generated.content === null) throw new Error("weekly_report_rewrite_quality_failed");
        const content = generated.content;
        let updated = false;
        ensureActive();
        // Even unchanged output goes through CAS: the baseline may have changed
        // during generation, in which case the new baseline must be reviewed.
        try {
          const saved = await input.writeLimiter.run(() => {
            ensureActive();
            return input.oa.replaceWeeklyReport({ ...target, context, content }, input.signal);
          }, input.signal);
          updated = saved.updated;
        } catch (error) {
          if (attempt === 0 && error instanceof OaRequestError && error.status === 409 && error.errorCode === "weekly_report_version_conflict") {
            await input.trace?.({ ...event, status: "running", message: "当前周报已变化，读取新正文后重新融合当天总结" });
            continue;
          }
          throw error;
        }
        const seenProjects = new Set<number>();
        for (const item of related) {
          handled.add(item);
          if (seenProjects.has(item.projectId)) continue;
          seenProjects.add(item.projectId);
          const report = reportFor(item);
          (report.weeklyReportSyncs ??= []).push({ reportId: context.report_id, weeklyNum: context.weekly_num, ownerId: context.owner_id, githubId: context.github_id, authorName: item.authorName, content, appended: false, mode: "replace", updated });
          if (updated) report.mutationsApplied = (report.mutationsApplied ?? 0) + 1;
        }
        if (updated) updates += 1;
        await input.trace?.({ ...event, status: "succeeded", message: updated ? "已融合当天总结并更新整篇周报" : "当天进展已体现在周报中，正文无需修改", metadataSanitized: { report_id: context.report_id, summary_count: summaries.length, updated } });
        break;
      }
    } catch (error) {
      if (error instanceof ProjectProgressLeaseLostError) throw error;
      input.signal?.throwIfAborted();
      const reason = error instanceof OaRequestError ? (error.errorCode ?? `http_${error.status}`) : error instanceof Error && /^weekly_report_[a-z_]+$/.test(error.message) ? error.message : "weekly_report_rewrite_failed";
      for (const item of related) {
        handled.add(item);
        reportFor(item).warnings.push(`weekly_report_write_failed:${item.summaryDate}:${reason}`);
      }
      await input.trace?.({ ...event, status: "failed", message: `整篇周报未更新，保留原文：${reason}` });
    }
  }
  return updates;
}
