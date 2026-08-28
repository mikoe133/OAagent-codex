import { createHash } from "node:crypto";

import { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import { isDefinitiveLeaseLossError } from "../infrastructure/oa/fencedMutation.js";
import type {
  ProjectProgressOaWriter,
  OaCommitSummary,
  OaProject,
} from "../infrastructure/oa/projectProgressOaClient.js";
import type {
  ProjectProgressProjectReport,
  ProjectProgressSummaryProposal,
  ProjectProgressSyncReport,
  ProjectProgressTraceSink,
} from "./syncProjectProgress.js";
import {
  type WeeklyReportAgentSummaryOutput,
  type WeeklyReportProjectSummaryAgent,
} from "./weeklyReportAgentSummarizer.js";

export type WeeklyReportSnapshot = {
  id: string;
  weeklyNum: number;
  ownerId?: number | null;
  content: string;
  version: number;
  updatedAt: string;
  deleted?: boolean;
};

export type WeeklyReportProject = Pick<OaProject, "id" | "projectName" | "status"> & {
  aliases?: string[];
};

export type WeeklyReportSplitMatch = {
  projectId: number;
  content: string;
  confidence: number;
  reason: "project_id" | "exact_name" | "alias" | "agent";
};

export type WeeklyReportSplitResult = {
  matches: WeeklyReportSplitMatch[];
  unmatched: string[];
  ambiguous: Array<{ content: string; projectIds: number[] }>;
};

export type WeeklyReportSyncInput = {
  report: WeeklyReportSnapshot;
  projects: WeeklyReportProject[];
  oaClient: ProjectProgressOaWriter;
  includeArchivedProjects?: boolean;
  writeArchivedProjects?: boolean;
  minimumConfidence?: number;
  shouldCancel?: () => boolean;
  summarizer?: WeeklyReportProjectSummaryAgent;
  trace?: ProjectProgressTraceSink;
  oaWriteConcurrency?: number;
};

export function splitWeeklyReportContent(
  content: string,
  projects: WeeklyReportProject[],
): WeeklyReportSplitResult {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const paragraphs = content
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const matches: WeeklyReportSplitMatch[] = [];
  const unmatched: string[] = [];
  const ambiguous: Array<{ content: string; projectIds: number[] }> = [];

  for (const paragraph of paragraphs) {
    const explicitIds = [...paragraph.matchAll(/(?:项目|project)\s*(?:id|编号)?\s*[#：:]?\s*(\d+)/giu)]
      .map((match) => Number(match[1]))
      .filter((id) => projectById.has(id));
    const idCandidates = [...new Set(explicitIds)];
    if (idCandidates.length === 1) {
      matches.push({
        projectId: idCandidates[0]!,
        content: paragraph,
        confidence: 1,
        reason: "project_id",
      });
      continue;
    }
    if (idCandidates.length > 1) {
      ambiguous.push({ content: paragraph, projectIds: idCandidates });
      unmatched.push(paragraph);
      continue;
    }

    const exactCandidates = projects.filter((project) =>
      project.projectName.trim().length > 0 && includesName(paragraph, project.projectName),
    );
    const exactIds = [...new Set(exactCandidates.map((project) => project.id))];
    if (exactIds.length === 1) {
      matches.push({
        projectId: exactIds[0]!,
        content: paragraph,
        confidence: 1,
        reason: "exact_name",
      });
      continue;
    }
    if (exactIds.length > 1) {
      ambiguous.push({ content: paragraph, projectIds: exactIds });
      unmatched.push(paragraph);
      continue;
    }

    const aliasCandidates = projects.filter((project) =>
      (project.aliases ?? []).some((alias) => alias.trim().length > 0 && includesName(paragraph, alias)),
    );
    const aliasIds = [...new Set(aliasCandidates.map((project) => project.id))];
    if (aliasIds.length === 1) {
      matches.push({
        projectId: aliasIds[0]!,
        content: paragraph,
        confidence: 0.9,
        reason: "alias",
      });
      continue;
    }
    if (aliasIds.length > 1) {
      ambiguous.push({ content: paragraph, projectIds: aliasIds });
      unmatched.push(paragraph);
    } else {
      unmatched.push(paragraph);
    }
  }
  return { matches, unmatched, ambiguous };
}

export function weeklyReportSummaryDate(weeklyNum: number): string {
  if (!Number.isInteger(weeklyNum) || weeklyNum < 197001 || weeklyNum > 999952) {
    throw new Error(`weekly_num 无效:${weeklyNum}`);
  }
  const year = Math.floor(weeklyNum / 100);
  const week = weeklyNum % 100;
  if (week < 1 || week > 53) throw new Error(`weekly_num 周数无效:${weeklyNum}`);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000 + (week - 1) * 7 * 86_400_000);
  const lastIsoWeekAnchor = new Date(Date.UTC(year, 11, 28));
  const maxWeek = Math.round(
    (lastIsoWeekAnchor.getTime() - (jan4.getTime() - (jan4Day - 1) * 86_400_000)) /
      (7 * 86_400_000),
  ) + 1;
  if (week > maxWeek) throw new Error(`weekly_num 不存在:${weeklyNum}`);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return sunday.toISOString().slice(0, 10);
}

export async function syncWeeklyReportProjectSummaries(
  input: WeeklyReportSyncInput,
): Promise<ProjectProgressSyncReport> {
  const observedAt = new Date(input.report.updatedAt);
  const summaryDate = weeklyReportSummaryDate(input.report.weeklyNum);
  const availableProjects = input.projects.filter((project) =>
    input.includeArchivedProjects !== false || project.status !== "archived",
  );
  await emitWeeklyTrace(input.trace, {
    eventKey: "weekly_report_source",
    sequence: 300,
    phase: "load_weekly_report",
    status: "succeeded",
    title: "读取周报快照",
    message: `已读取周报 ${input.report.weeklyNum} 第 ${input.report.version} 版`,
    progressCurrent: 1,
    progressTotal: 1,
  });
  await emitWeeklyTrace(input.trace, {
    eventKey: "weekly_report_projects",
    sequence: 400,
    phase: "load_projects",
    status: "succeeded",
    title: "读取项目目录",
    message: `已读取 ${availableProjects.length} 个可处理项目`,
    progressCurrent: availableProjects.length,
    progressTotal: availableProjects.length,
  });
  if (input.summarizer) {
    await emitWeeklyTrace(input.trace, {
      eventKey: "weekly_report_agent",
      sequence: 500,
      phase: "weekly_report_agent",
      status: "running",
      title: "Agent 归纳周报项目进展",
      message: `正在分析周报并匹配 ${availableProjects.length} 个项目`,
      progressCurrent: 0,
      progressTotal: availableProjects.length,
    });
  }
  let agentResult: WeeklyReportAgentSummaryOutput | null = null;
  if (input.summarizer) {
    try {
      agentResult = await input.summarizer.summarize({
        report: input.report,
        projects: availableProjects,
      });
    } catch (error) {
      await emitWeeklyTrace(input.trace, {
        eventKey: "weekly_report_agent",
        sequence: 500,
        phase: "weekly_report_agent",
        status: "failed",
        title: "Agent 归纳周报项目进展",
        message: safeError(error),
        progressCurrent: 0,
        progressTotal: availableProjects.length,
      });
      throw error;
    }
  }
  if (input.summarizer) {
    await emitWeeklyTrace(input.trace, {
      eventKey: "weekly_report_agent",
      sequence: 500,
      phase: "weekly_report_agent",
      status: agentResult?.interaction?.fallbackUsed ? "fallback" : "succeeded",
      title: "Agent 归纳周报项目进展",
      message: agentResult?.interaction?.fallbackUsed
        ? "Agent 归纳失败，已使用确定性项目匹配兜底"
        : `已归纳 ${agentResult?.projects.length ?? 0} 个项目`,
      progressCurrent: agentResult?.projects.length ?? 0,
      progressTotal: availableProjects.length,
    });
  }
  const split = agentResult
    ? agentResultToSplit(agentResult, availableProjects)
    : splitWeeklyReportContent(input.report.content, availableProjects);
  await emitWeeklyTrace(input.trace, {
    eventKey: "weekly_report_split",
    sequence: 550,
    phase: "split_weekly_report",
    status: "succeeded",
    title: "校验 Agent 项目归纳",
    message: `确认 ${agentResult?.projects.length ?? split.matches.length} 个项目归纳结果`,
    progressCurrent: agentResult?.projects.length ?? split.matches.length,
    progressTotal: availableProjects.length,
    metadataSanitized: {
      matched_projects: agentResult?.projects.length ?? split.matches.length,
      unmatched_segments: split.unmatched.length,
      ambiguous_segments: split.ambiguous.length,
    },
  });
  const minimumConfidence = input.minimumConfidence ?? 0.8;
  const agentFallbackWarning = agentResult?.interaction?.fallbackUsed
    ? "weekly_report_agent_fallback"
    : undefined;

  const groupedMatches = new Map<number, WeeklyReportSplitMatch>();
  for (const match of split.matches) {
    const previous = groupedMatches.get(match.projectId);
    groupedMatches.set(match.projectId, previous
      ? {
          ...previous,
          content: `${previous.content}\n\n${match.content}`,
          confidence: Math.min(previous.confidence, match.confidence),
        }
      : match);
  }
  const writePlans = [...groupedMatches.values()]
    .filter((match) => match.confidence >= minimumConfidence)
    .map((match) => ({
      match,
      project: availableProjects.find((candidate) => candidate.id === match.projectId),
    }))
    .filter((plan): plan is { match: WeeklyReportSplitMatch; project: WeeklyReportProject } =>
      plan.project !== undefined,
    );
  const writeLimiter = new AsyncSemaphore(input.oaWriteConcurrency ?? 4);
  await emitWeeklyTrace(input.trace, {
    eventKey: "weekly_report_writes",
    sequence: 600,
    phase: "write_project_summaries",
    status: writePlans.length > 0 ? "running" : "succeeded",
    title: "并发写入项目总结",
    message: writePlans.length > 0
      ? `准备写入 ${writePlans.length} 个项目，最大并发 ${writeLimiter.concurrency}`
      : "没有达到置信度阈值的项目",
    progressCurrent: 0,
    progressTotal: writePlans.length,
  });
  const writeResults = await Promise.all(writePlans.map(async ({ match, project }) =>
    writeLimiter.run(async () => {
      if (input.shouldCancel?.()) return null;
      await emitWeeklyTrace(input.trace, {
        eventKey: `weekly_report_write:${project.id}`,
        sequence: 610,
        phase: "write_project_summary",
        status: "running",
        title: "写入项目总结",
        message: project.projectName,
        projectId: project.id,
      });
      const result = await writeProjectSummary({
        input,
        project,
        match,
        summaryDate,
        interaction: agentResult?.interaction,
        ...(agentFallbackWarning ? { warning: agentFallbackWarning } : {}),
      });
      const hasWriteFailure = result.report.warnings.some((warning) => warning.startsWith("summary_write_failed:"));
      await emitWeeklyTrace(input.trace, {
        eventKey: `weekly_report_write:${project.id}`,
        sequence: 610,
        phase: "write_project_summary",
        status: hasWriteFailure ? "failed" : result.report.warnings.length > 0 ? "fallback" : "succeeded",
        title: "写入项目总结",
        message: hasWriteFailure ? "项目总结写入失败" : "项目总结写入完成",
        projectId: project.id,
        metadataSanitized: { mutations_applied: result.mutationsApplied },
      });
      return result;
    }),
  ));
  const reports = writeResults
    .filter((result): result is { report: ProjectProgressProjectReport; mutationsApplied: number } =>
      result !== null,
    );
  const mutationsApplied = reports.reduce((total, result) => total + result.mutationsApplied, 0);
  const reportItems = reports.map((result) => result.report);
  const hasWriteFailure = reportItems.some((report) =>
    report.warnings.some((warning) => warning.startsWith("summary_write_failed:")),
  );
  await emitWeeklyTrace(input.trace, {
    eventKey: "weekly_report_writes",
    sequence: 600,
    phase: "write_project_summaries",
    status: input.shouldCancel?.() ? "cancelled" : hasWriteFailure ? "failed" : "succeeded",
    title: "并发写入项目总结",
    message: `已处理 ${reportItems.length}/${writePlans.length} 个项目`,
    progressCurrent: reportItems.length,
    progressTotal: writePlans.length,
    metadataSanitized: { mutations_applied: mutationsApplied },
  });

  return {
    mode: "production-write",
    observedAt: observedAt.toISOString(),
    mutationsApplied,
    retryRecommended: reportItems.some((report) =>
      report.warnings.some((warning) =>
        warning.startsWith("summary_write_failed:") || warning === "weekly_report_agent_fallback",
      ),
    ),
    cancelled: Boolean(input.shouldCancel?.()),
    metrics: {
      repositoriesDiscovered: 0,
      repositoriesWithCommits: 0,
      repositoryTasksTotal: reportItems.length,
      repositoryTasksSucceeded: reportItems.filter((report) => report.warnings.length === 0).length,
      repositoryTasksFallback: agentResult?.interaction?.fallbackUsed ? reportItems.length : 0,
      repositoryTasksFailed: reportItems.filter((report) => report.warnings.length > 0).length,
      githubPeakConcurrency: 0,
      agentPeakConcurrency: agentResult ? 1 : 0,
      oaWritePeakConcurrency: writeLimiter.metrics.peakActive,
    },
    operationMetrics: [],
    projects: reportItems,
  };
}

function agentResultToSplit(
  result: WeeklyReportAgentSummaryOutput,
  projects: WeeklyReportProject[],
): WeeklyReportSplitResult {
  const projectIds = new Set(projects.map((project) => project.id));
  const grouped = new Map<number, WeeklyReportSplitMatch>();
  for (const item of result.projects) {
    if (!projectIds.has(item.projectId) || !item.summary.trim()) continue;
    const previous = grouped.get(item.projectId);
    grouped.set(item.projectId, previous
      ? {
          ...previous,
          content: `${previous.content}\n\n${item.summary}`,
          confidence: Math.min(previous.confidence, item.confidence),
        }
      : {
          projectId: item.projectId,
          content: item.summary,
          confidence: item.confidence,
          reason: "agent",
        });
  }
  return {
    matches: [...grouped.values()],
    unmatched: result.unmatched,
    ambiguous: [],
  };
}

async function writeProjectSummary(input: {
  input: WeeklyReportSyncInput;
  project: WeeklyReportProject;
  match: WeeklyReportSplitMatch;
  summaryDate: string;
  interaction?: ProjectProgressSummaryProposal["interaction"];
  warning?: string;
}): Promise<{ report: ProjectProgressProjectReport; mutationsApplied: number }> {
  const { project, match, summaryDate } = input;
  const aiNote = formatWeeklyReportNote(input.input.report, match.content);
  const sourceDigest = createHash("sha256").update(`${input.input.report.id}:${input.input.report.version}:${project.id}:${match.content}`).digest("hex");
  const summary: ProjectProgressSummaryProposal = {
    summaryDate,
    commitCount: 0,
    sourceDigest,
    summary: match.content,
    aiConfidence: Math.round(match.confidence * 100),
    aiNote,
    ...(input.interaction ? { interaction: input.interaction } : {}),
  };
  let mutationsApplied = 0;
  const warnings: string[] = input.warning ? [input.warning] : [];
  try {
    if (project.status === "archived" && input.input.writeArchivedProjects === false) {
      warnings.push("archived_project_write_disabled");
    } else {
      const existing = (await input.input.oaClient.listCommitSummaries(project.id, summaryDate)).at(0);
      if (existing && (existing.summary !== match.content || existing.aiNote !== aiNote)) {
        await input.input.oaClient.updateCommitSummary(existing.id, {
          summary: match.content,
          aiConfidence: summary.aiConfidence,
          aiNote,
          ...(existing.version === undefined ? {} : { expectedVersion: existing.version }),
        });
        mutationsApplied += 1;
      } else if (!existing) {
        await input.input.oaClient.createCommitSummary({
          projectId: project.id,
          summaryDate,
          summary: match.content,
          aiConfidence: summary.aiConfidence,
          aiNote,
        });
        mutationsApplied += 1;
      }
    }
  } catch (error) {
    warnings.push(`summary_write_failed:${safeError(error)}`);
  }
  return {
    mutationsApplied,
    report: {
      projectId: project.id,
      projectName: project.projectName,
      currentStatus: project.status,
      targetStatus: project.status,
      outcome: project.status === "archived" ? "archived" : warnings.length ? "failed" : "evaluated",
      warnings,
      summaries: [summary],
      repositoryCount: 0,
      commitCount: 0,
      mutationsApplied,
    },
  };
}

function includesName(content: string, name: string): boolean {
  const normalizedContent = content.toLocaleLowerCase();
  const normalizedName = name.trim().toLocaleLowerCase();
  return normalizedName.length > 0 && normalizedContent.includes(normalizedName);
}

function formatWeeklyReportNote(report: WeeklyReportSnapshot, projectContent: string): string {
  const prefix = `${report.weeklyNum} 周报（${report.updatedAt}）：`;
  return `${prefix}${report.content}\n项目拆分片段：${projectContent}`.slice(0, 10_000);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown_error")
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/sessionid=[^\s;]+/gi, "sessionid=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function emitWeeklyTrace(
  sink: ProjectProgressTraceSink | undefined,
  event: Parameters<ProjectProgressTraceSink>[0],
): Promise<void> {
  if (!sink) return;
  try {
    await sink(event);
  } catch (error) {
    if (isDefinitiveLeaseLossError(error)) throw error;
  }
}

export type WeeklyReportProjectSummaryWriter = ProjectProgressOaWriter;
export type WeeklyReportProjectSummarySource = WeeklyReportSnapshot;
export type WeeklyReportSummaryRecord = OaCommitSummary;
