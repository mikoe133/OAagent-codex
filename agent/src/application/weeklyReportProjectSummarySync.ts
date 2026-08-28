import { createHash } from "node:crypto";

import type {
  ProjectProgressOaWriter,
  OaCommitSummary,
  OaProject,
} from "../infrastructure/oa/projectProgressOaClient.js";
import type {
  ProjectProgressProjectReport,
  ProjectProgressSummaryProposal,
  ProjectProgressSyncReport,
} from "./syncProjectProgress.js";

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
  reason: "project_id" | "exact_name" | "alias";
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
  const split = splitWeeklyReportContent(input.report.content, availableProjects);
  const minimumConfidence = input.minimumConfidence ?? 0.8;
  const reports: ProjectProgressProjectReport[] = [];
  let mutationsApplied = 0;

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
  for (const match of groupedMatches.values()) {
    if (input.shouldCancel?.()) break;
    if (match.confidence < minimumConfidence) continue;
    const project = availableProjects.find((candidate) => candidate.id === match.projectId);
    if (!project) continue;
    const report = await writeProjectSummary({
      input,
      project,
      match,
      summaryDate,
    });
    reports.push(report.report);
    mutationsApplied += report.mutationsApplied;
  }

  return {
    mode: "production-write",
    observedAt: observedAt.toISOString(),
    mutationsApplied,
    retryRecommended: reports.some((report) =>
      report.warnings.some((warning) => warning.startsWith("summary_write_failed:")),
    ),
    cancelled: Boolean(input.shouldCancel?.()),
    metrics: {
      repositoriesDiscovered: 0,
      repositoriesWithCommits: 0,
      repositoryTasksTotal: reports.length,
      repositoryTasksSucceeded: reports.filter((report) => report.warnings.length === 0).length,
      repositoryTasksFallback: 0,
      repositoryTasksFailed: reports.filter((report) => report.warnings.length > 0).length,
      githubPeakConcurrency: 0,
      agentPeakConcurrency: 0,
      oaWritePeakConcurrency: 1,
    },
    operationMetrics: [],
    projects: reports,
  };
}

async function writeProjectSummary(input: {
  input: WeeklyReportSyncInput;
  project: WeeklyReportProject;
  match: WeeklyReportSplitMatch;
  summaryDate: string;
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
  };
  let mutationsApplied = 0;
  const warnings: string[] = [];
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
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export type WeeklyReportProjectSummaryWriter = ProjectProgressOaWriter;
export type WeeklyReportProjectSummarySource = WeeklyReportSnapshot;
export type WeeklyReportSummaryRecord = OaCommitSummary;
