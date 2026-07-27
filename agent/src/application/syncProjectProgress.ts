import {
  buildProjectDailyCommitGroups,
  decideProjectStatus,
  type ProjectStatus,
} from "../domain/projectProgress.js";
import { normalizeGitHubRepositoryUrl } from "../infrastructure/github/githubUrl.js";
import type {
  GitHubRepositorySnapshot,
  ProjectProgressGitHubReader,
} from "../infrastructure/github/githubTypes.js";
import type {
  OaCommitSummary,
  OaProject,
  ProjectProgressOaReader,
  ProjectProgressOaWriter,
} from "../infrastructure/oa/projectProgressOaClient.js";
import type { ManagedProjectSummary } from "../infrastructure/persistence/projectProgressStore.js";
import type { ProjectProgressSummarizer } from "./projectProgressSummarizer.js";

export type ProjectProgressSummaryProposal = {
  summaryDate: string;
  commitCount: number;
  sourceDigest: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
};

export type ProjectProgressProjectReport = {
  projectId: number;
  projectName: string;
  currentStatus: ProjectStatus;
  targetStatus: ProjectStatus;
  outcome: "archived" | "no_github_urls" | "invalid_github_urls" | "incomplete" | "evaluated";
  warnings: string[];
  summaries: ProjectProgressSummaryProposal[];
};

export type ProjectProgressSyncReport = {
  mode: "dry-run" | "unsafe-test-write";
  observedAt: string;
  mutationsApplied: number;
  projects: ProjectProgressProjectReport[];
};

type ProjectProgressStateSink = {
  saveProjectRepositoryWatermark(
    projectId: number,
    repositoryId: number,
    watermark: string,
  ): void;
  saveDailySummaryDraft?(input: {
    projectId: number;
    summaryDate: string;
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  }): void;
  getDailySummaryDraft?(
    projectId: number,
    summaryDate: string,
  ): {
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  } | null;
  enqueueOutbox?(input: {
    intentKey: string;
    operation: string;
    projectId: number;
    payload: Record<string, unknown>;
  }): void;
  markOutboxApplied?(intentKey: string): void;
  getManagedSummary?(
    projectId: number,
    summaryDate: string,
  ): ManagedProjectSummary | null;
  markSummaryApplied?(input: {
    projectId: number;
    summaryDate: string;
    summaryId: number;
    sourceDigest: string;
    summary: string;
    aiConfidence: number;
    aiNote: string;
  }): void;
};

type WritableProjectProgressState = Required<
  Pick<
    ProjectProgressStateSink,
    | "enqueueOutbox"
    | "markOutboxApplied"
    | "getManagedSummary"
    | "markSummaryApplied"
  >
>;

export async function syncProjectProgress(input: {
  observedAt: Date;
  oaClient: ProjectProgressOaReader;
  githubReader: ProjectProgressGitHubReader;
  summarizer: ProjectProgressSummarizer;
  store?: ProjectProgressStateSink;
  projectId?: number;
  writeMode?: "dry-run" | "unsafe-test";
}): Promise<ProjectProgressSyncReport> {
  const writeMode = input.writeMode ?? "dry-run";
  if (writeMode === "unsafe-test" && input.projectId === undefined) {
    throw new Error("unsafe-test 写入必须指定单个 projectId。");
  }
  const writer = writeMode === "unsafe-test"
    ? requireOaWriter(input.oaClient)
    : null;
  const writableStore = writeMode === "unsafe-test"
    ? requireWritableStore(input.store)
    : null;
  const listedProjects = await input.oaClient.listProjects();
  const projects = input.projectId === undefined
    ? listedProjects
    : listedProjects.filter((project) => project.id === input.projectId);
  const repositoryCache = new Map<string, Promise<GitHubRepositorySnapshot>>();
  const reports: ProjectProgressProjectReport[] = [];
  let mutationsApplied = 0;

  for (const listedProject of projects) {
    if (listedProject.status === "archived") {
      reports.push(archivedReport(listedProject));
      continue;
    }

    let project: OaProject;
    try {
      project = await input.oaClient.getProject(listedProject.id);
    } catch (error) {
      reports.push(incompleteReport(listedProject, `project_detail_failed:${errorMessage(error)}`));
      continue;
    }
    if (project.status === "archived") {
      reports.push(archivedReport(project));
      continue;
    }
    if (project.githubUrls.length === 0) {
      reports.push({
        projectId: project.id,
        projectName: project.projectName,
        currentStatus: project.status,
        targetStatus: project.status,
        outcome: "no_github_urls",
        warnings: ["no_github_urls"],
        summaries: [],
      });
      continue;
    }

    let repositories;
    try {
      repositories = [...new Map(
        project.githubUrls.map((url) => {
          const repository = normalizeGitHubRepositoryUrl(url);
          return [repository.fullName.toLowerCase(), repository] as const;
        }),
      ).values()];
    } catch (error) {
      reports.push({
        projectId: project.id,
        projectName: project.projectName,
        currentStatus: project.status,
        targetStatus: project.status,
        outcome: "invalid_github_urls",
        warnings: [`invalid_github_url:${errorMessage(error)}`],
        summaries: [],
      });
      continue;
    }

    const snapshots: GitHubRepositorySnapshot[] = [];
    const warnings: string[] = [];
    for (const repository of repositories) {
      try {
        const cacheKey = repository.fullName.toLowerCase();
        let pending = repositoryCache.get(cacheKey);
        if (!pending) {
          pending = input.githubReader.readRepository(repository, input.observedAt);
          repositoryCache.set(cacheKey, pending);
        }
        const snapshot = await pending;
        snapshots.push(snapshot);
      } catch (error) {
        warnings.push(`repository_read_failed:${repository.fullName}:${errorMessage(error)}`);
        snapshots.push({
          repositoryId: -1,
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: false,
          lastActivityAt: null,
          commits: [],
        });
      }
    }

    const decision = decideProjectStatus({
      currentStatus: project.status,
      observedAt: input.observedAt,
      repositories: snapshots.map((snapshot) => ({
        complete: snapshot.complete,
        lastActivityAt: snapshot.lastActivityAt,
      })),
    });
    const complete = snapshots.every((snapshot) => snapshot.complete);
    const summaries: ProjectProgressSummaryProposal[] = [];
    if (complete) {
      for (const snapshot of snapshots) {
        input.store?.saveProjectRepositoryWatermark(
          project.id,
          snapshot.repositoryId,
          input.observedAt.toISOString(),
        );
      }
      const groups = buildProjectDailyCommitGroups(
        snapshots.flatMap((snapshot) => snapshot.commits),
        input.observedAt,
      );
      for (const group of groups) {
        const existing = input.store?.getDailySummaryDraft?.(
          project.id,
          group.summaryDate,
        );
        if (existing?.sourceDigest === group.sourceDigest) {
          summaries.push({
            summaryDate: group.summaryDate,
            commitCount: group.commits.length,
            sourceDigest: group.sourceDigest,
            summary: existing.summary,
            aiConfidence: existing.aiConfidence,
            aiNote: existing.aiNote,
          });
          continue;
        }
        const generated = await input.summarizer.summarize({
          projectId: project.id,
          projectName: project.projectName,
          summaryDate: group.summaryDate,
          commits: group.commits,
        });
        const anomalyCount = group.commits.filter((commit) => commit.timestampAnomaly).length;
        const aiConfidence = Math.max(
          35,
          90 - anomalyCount * 10 - (generated.limitations.length > 0 ? 20 : 0),
        );
        const aiNoteParts = [
          `基于 ${snapshots.length} 个仓库的 ${group.commits.length} 条提交`,
          ...(anomalyCount > 0 ? [`${anomalyCount} 条提交时间异常`] : []),
          ...generated.limitations,
        ];
        const proposal = {
          summaryDate: group.summaryDate,
          commitCount: group.commits.length,
          sourceDigest: group.sourceDigest,
          summary: generated.summary,
          aiConfidence,
          aiNote: `${aiNoteParts.join("；")}。`,
        };
        summaries.push(proposal);
        input.store?.saveDailySummaryDraft?.({
          projectId: project.id,
          summaryDate: proposal.summaryDate,
          sourceDigest: proposal.sourceDigest,
          summary: proposal.summary,
          aiConfidence: proposal.aiConfidence,
          aiNote: proposal.aiNote,
        });
      }
    }

    if (writer && writableStore && complete) {
      try {
        const applied = await applyUnsafeTestMutations({
          project,
          observedAt: input.observedAt,
          targetStatus: decision.targetStatus,
          summaries,
          writer,
          store: writableStore,
          warnings,
        });
        mutationsApplied += applied;
      } catch (error) {
        warnings.push(`test_write_failed:${errorMessage(error)}`);
      }
    }

    reports.push({
      projectId: project.id,
      projectName: project.projectName,
      currentStatus: project.status,
      targetStatus: decision.targetStatus,
      outcome: complete ? "evaluated" : "incomplete",
      warnings,
      summaries,
    });
  }

  return {
    mode: writeMode === "unsafe-test" ? "unsafe-test-write" : "dry-run",
    observedAt: input.observedAt.toISOString(),
    mutationsApplied,
    projects: reports,
  };
}

async function applyUnsafeTestMutations(input: {
  project: OaProject;
  observedAt: Date;
  targetStatus: Exclude<ProjectStatus, "archived">;
  summaries: ProjectProgressSummaryProposal[];
  writer: ProjectProgressOaWriter;
  store: WritableProjectProgressState;
  warnings: string[];
}): Promise<number> {
  const latest = await input.writer.getProject(input.project.id);
  if (latest.status === "archived") {
    input.warnings.push("test_write_cancelled:project_archived");
    return 0;
  }
  if (repositorySetKey(latest.githubUrls) !== repositorySetKey(input.project.githubUrls)) {
    input.warnings.push("test_write_cancelled:github_urls_changed");
    return 0;
  }

  let applied = 0;
  if (latest.status !== input.targetStatus) {
    const intentKey = [
      "test:status",
      latest.id,
      latest.status,
      input.targetStatus,
      input.observedAt.toISOString(),
    ].join(":");
    input.store.enqueueOutbox({
      intentKey,
      operation: "project.status.update",
      projectId: latest.id,
      payload: { status: input.targetStatus },
    });
    try {
      await input.writer.updateProjectStatus(latest.id, input.targetStatus);
      input.store.markOutboxApplied(intentKey);
      applied += 1;
    } catch (error) {
      input.warnings.push(`status_write_failed:${errorMessage(error)}`);
    }
  }

  for (const proposal of input.summaries) {
    try {
      applied += await reconcileUnsafeTestSummary({
        projectId: latest.id,
        proposal,
        writer: input.writer,
        store: input.store,
        warnings: input.warnings,
      });
    } catch (error) {
      input.warnings.push(
        `summary_write_failed:${proposal.summaryDate}:${errorMessage(error)}`,
      );
    }
  }
  return applied;
}

async function reconcileUnsafeTestSummary(input: {
  projectId: number;
  proposal: ProjectProgressSummaryProposal;
  writer: ProjectProgressOaWriter;
  store: WritableProjectProgressState;
  warnings: string[];
}): Promise<number> {
  const existing = await input.writer.listCommitSummaries(
    input.projectId,
    input.proposal.summaryDate,
  );
  if (existing.length > 1) {
    input.warnings.push(`summary_conflict:${input.proposal.summaryDate}:multiple_records`);
    return 0;
  }

  const desired = summaryPayload(input.proposal);
  if (existing.length === 0) {
    const intentKey = summaryIntentKey("create", input.projectId, input.proposal);
    input.store.enqueueOutbox({
      intentKey,
      operation: "summary.create",
      projectId: input.projectId,
      payload: desired,
    });
    const created = await input.writer.createCommitSummary({
      projectId: input.projectId,
      summaryDate: input.proposal.summaryDate,
      ...desired,
    });
    markSummaryApplied(input, created.id);
    input.store.markOutboxApplied(intentKey);
    return 1;
  }

  const current = existing[0]!;
  const managed = input.store.getManagedSummary(
    input.projectId,
    input.proposal.summaryDate,
  );
  if (!managed || managed.summaryId !== current.id) {
    input.warnings.push(`summary_unmanaged:${input.proposal.summaryDate}:${current.id}`);
    return 0;
  }
  if (!summaryMatchesAppliedPayload(current, managed)) {
    input.warnings.push(`summary_external_edit:${input.proposal.summaryDate}:${current.id}`);
    return 0;
  }
  if (
    managed.sourceDigest === input.proposal.sourceDigest &&
    summaryMatchesDesired(current, desired)
  ) {
    return 0;
  }

  const intentKey = summaryIntentKey("update", input.projectId, input.proposal);
  input.store.enqueueOutbox({
    intentKey,
    operation: "summary.update",
    projectId: input.projectId,
    payload: { summaryId: current.id, ...desired },
  });
  await input.writer.updateCommitSummary(current.id, desired);
  markSummaryApplied(input, current.id);
  input.store.markOutboxApplied(intentKey);
  return 1;
}

function markSummaryApplied(
  input: {
    projectId: number;
    proposal: ProjectProgressSummaryProposal;
    store: WritableProjectProgressState;
  },
  summaryId: number,
): void {
  input.store.markSummaryApplied({
    projectId: input.projectId,
    summaryDate: input.proposal.summaryDate,
    summaryId,
    sourceDigest: input.proposal.sourceDigest,
    summary: input.proposal.summary,
    aiConfidence: input.proposal.aiConfidence,
    aiNote: input.proposal.aiNote,
  });
}

function summaryPayload(proposal: ProjectProgressSummaryProposal): {
  summary: string;
  aiConfidence: number;
  aiNote: string;
} {
  return {
    summary: proposal.summary,
    aiConfidence: proposal.aiConfidence,
    aiNote: proposal.aiNote,
  };
}

function summaryMatchesAppliedPayload(
  summary: OaCommitSummary,
  managed: ManagedProjectSummary,
): boolean {
  return summaryMatchesDesired(summary, managed.appliedPayload);
}

function summaryMatchesDesired(
  summary: OaCommitSummary,
  desired: { summary: string; aiConfidence: number; aiNote: string },
): boolean {
  return summary.summary === desired.summary &&
    summary.aiConfidence === desired.aiConfidence &&
    summary.aiNote === desired.aiNote;
}

function summaryIntentKey(
  operation: "create" | "update",
  projectId: number,
  proposal: ProjectProgressSummaryProposal,
): string {
  return `test:summary:${operation}:${projectId}:${proposal.summaryDate}:${proposal.sourceDigest}`;
}

function repositorySetKey(urls: string[]): string {
  return urls
    .map((url) => normalizeGitHubRepositoryUrl(url).fullName.toLowerCase())
    .sort()
    .join("\n");
}

function requireOaWriter(reader: ProjectProgressOaReader): ProjectProgressOaWriter {
  const candidate = reader as Partial<ProjectProgressOaWriter>;
  if (
    typeof candidate.updateProjectStatus !== "function" ||
    typeof candidate.listCommitSummaries !== "function" ||
    typeof candidate.createCommitSummary !== "function" ||
    typeof candidate.updateCommitSummary !== "function"
  ) {
    throw new Error("unsafe-test 写入需要完整 OA writer。");
  }
  return reader as ProjectProgressOaWriter;
}

function requireWritableStore(
  store: ProjectProgressStateSink | undefined,
): ProjectProgressStateSink & WritableProjectProgressState {
  if (
    !store ||
    typeof store.enqueueOutbox !== "function" ||
    typeof store.markOutboxApplied !== "function" ||
    typeof store.getManagedSummary !== "function" ||
    typeof store.markSummaryApplied !== "function"
  ) {
    throw new Error("unsafe-test 写入需要持久化 outbox 和 managed summary 状态。");
  }
  return store as ProjectProgressStateSink & WritableProjectProgressState;
}

function archivedReport(project: OaProject): ProjectProgressProjectReport {
  return {
    projectId: project.id,
    projectName: project.projectName,
    currentStatus: "archived",
    targetStatus: "archived",
    outcome: "archived",
    warnings: [],
    summaries: [],
  };
}

function incompleteReport(project: OaProject, warning: string): ProjectProgressProjectReport {
  return {
    projectId: project.id,
    projectName: project.projectName,
    currentStatus: project.status,
    targetStatus: project.status,
    outcome: "incomplete",
    warnings: [warning],
    summaries: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
