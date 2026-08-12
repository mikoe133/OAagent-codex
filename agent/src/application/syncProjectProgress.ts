import { createHash } from "node:crypto";
import {
  buildProjectDailyCommitGroups,
  decideProjectStatus,
  formatDateInTimeZone,
  PROJECT_PROGRESS_TIME_ZONE,
  type NormalizedProjectProgressCommit,
  type ProjectDailyCommitGroup,
  type ProjectStatus,
} from "../domain/projectProgress.js";
import { AsyncSemaphore } from "../infrastructure/concurrency/asyncSemaphore.js";
import { GitHubRequestError } from "../infrastructure/github/githubClient.js";
import { normalizeGitHubRepositoryUrl } from "../infrastructure/github/githubUrl.js";
import type { GitHubRepositoryIdentity } from "../infrastructure/github/githubUrl.js";
import type {
  GitHubRepositoryReadProgress,
  GitHubRepositorySnapshot,
  ProjectProgressGitHubReader,
} from "../infrastructure/github/githubTypes.js";
import { isDefinitiveLeaseLossError } from "../infrastructure/oa/fencedMutation.js";
import type {
  OaCommitSummary,
  OaProject,
  ProjectProgressOaReader,
  ProjectProgressOaWriter,
} from "../infrastructure/oa/projectProgressOaClient.js";
import { ProjectProgressLeaseLostError } from "../infrastructure/oa/projectProgressOaClient.js";
import {
  OperationMetricsRecorder,
  PROJECT_PROGRESS_ENDPOINTS,
  type OperationMetricSnapshot,
} from "../infrastructure/observability/operationMetrics.js";
import type { ManagedProjectSummary } from "../infrastructure/persistence/projectProgressStore.js";
import type {
  ProjectProgressAiInteraction,
  ProjectProgressSummarizer,
} from "./projectProgressSummarizer.js";
import {
  DeterministicProjectProgressSummarizer,
  isInvalidProjectProgressSummary,
} from "./projectProgressSummarizer.js";

export type ProjectProgressConcurrency = {
  github: number;
  agent: number;
  oaWrite: 1;
};

export type ProjectProgressTraceEvent = {
  eventKey: string;
  sequence: number;
  phase: string;
  status: "pending" | "running" | "succeeded" | "fallback" | "failed" | "cancelled";
  title: string;
  message?: string;
  progressCurrent?: number;
  progressTotal?: number;
  projectId?: number;
  repositoryFullName?: string;
  metadataSanitized?: Record<string, unknown>;
};

export type ProjectProgressTraceSink = (
  event: ProjectProgressTraceEvent,
) => void | Promise<void>;

export type ProjectProgressRepositoryInteraction = {
  repositoryKey: string;
  interaction: ProjectProgressAiInteraction;
};

export type ProjectProgressSummaryProposal = {
  summaryDate: string;
  commitCount: number;
  sourceDigest: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
  interaction?: ProjectProgressAiInteraction;
  repositoryInteractions?: ProjectProgressRepositoryInteraction[];
};

export type ProjectProgressProjectReport = {
  projectId: number;
  projectName: string;
  currentStatus: ProjectStatus;
  targetStatus: ProjectStatus;
  outcome: "archived" | "no_github_urls" | "invalid_github_urls" | "incomplete" | "no_commits" | "evaluated";
  warnings: string[];
  summaries: ProjectProgressSummaryProposal[];
  repositoryCount?: number;
  commitCount?: number;
  mutationsApplied?: number;
};

export type ProjectProgressSyncReport = {
  mode: "dry-run" | "unsafe-test-write" | "production-write";
  observedAt: string;
  mutationsApplied: number;
  retryRecommended: boolean;
  cancelled: boolean;
  metrics: {
    repositoriesDiscovered: number;
    repositoriesWithCommits: number;
    repositoryTasksTotal: number;
    repositoryTasksSucceeded: number;
    repositoryTasksFallback: number;
    repositoryTasksFailed: number;
    githubPeakConcurrency: number;
    agentPeakConcurrency: number;
    oaWritePeakConcurrency: number;
  };
  operationMetrics: OperationMetricSnapshot[];
  projects: ProjectProgressProjectReport[];
};

type PreparedProject = {
  project: OaProject & { status: Exclude<ProjectStatus, "archived"> };
  repositories: GitHubRepositoryIdentity[];
};

type ProjectEntry =
  | { kind: "report"; report: ProjectProgressProjectReport }
  | { kind: "project"; prepared: PreparedProject };

type RepositorySnapshotResult =
  | { snapshot: GitHubRepositorySnapshot; error?: never }
  | { snapshot?: never; error: unknown };

type ProjectGroupPlan = {
  group: ProjectDailyCommitGroup;
  cached: ProjectProgressSummaryProposal | null;
};

type ProjectEvaluation = {
  prepared: PreparedProject;
  snapshots: GitHubRepositorySnapshot[];
  warnings: string[];
  complete: boolean;
  targetStatus: Exclude<ProjectStatus, "archived">;
  groups: ProjectGroupPlan[];
};

type RepositorySummaryTask = {
  key: string;
  repositoryKey: string;
  summaryDate: string;
  projectId: number;
  projectName: string;
  commits: NormalizedProjectProgressCommit[];
};

type SuccessfulRepositorySummaryResult = {
  key: string;
  repositoryKey: string;
  summary: string;
  limitations: string[];
  interaction?: ProjectProgressAiInteraction;
  status: "succeeded" | "fallback";
};

type FailedRepositorySummaryResult = {
  key: string;
  repositoryKey: string;
  status: "failed";
  error: string;
};

type RepositorySummaryResult =
  | SuccessfulRepositorySummaryResult
  | FailedRepositorySummaryResult;

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

export type ProjectProgressSyncInput = {
  observedAt: Date;
  oaClient: ProjectProgressOaReader;
  githubReader: ProjectProgressGitHubReader;
  summarizer: ProjectProgressSummarizer;
  store?: ProjectProgressStateSink;
  projectId?: number;
  writeMode?: "dry-run" | "unsafe-test" | "production";
  concurrency?: ProjectProgressConcurrency;
  githubRequestLimiter?: AsyncSemaphore;
  operationMetrics?: OperationMetricsRecorder;
  projectDetailCompatibilityMode?: boolean;
  shouldCancel?: () => boolean;
  trace?: ProjectProgressTraceSink;
  forceRegenerateSummaries?: boolean;
  summaryWritePolicy?: "managed-only" | "manual-overwrite";
};

export function projectProgressExecutionPolicy(triggerSource: string): Pick<
  ProjectProgressSyncInput,
  "forceRegenerateSummaries" | "summaryWritePolicy"
> {
  if (triggerSource === "manual") {
    return {
      forceRegenerateSummaries: true,
      summaryWritePolicy: "manual-overwrite",
    };
  }
  if (triggerSource === "retry") {
    return {
      forceRegenerateSummaries: true,
      summaryWritePolicy: "managed-only",
    };
  }
  return {
    forceRegenerateSummaries: false,
    summaryWritePolicy: "managed-only",
  };
}

export async function syncProjectProgress(
  input: ProjectProgressSyncInput,
): Promise<ProjectProgressSyncReport> {
  const cancellation = createCancellationMonitor(input.shouldCancel);
  const operationMetrics = input.operationMetrics ?? new OperationMetricsRecorder();
  try {
    return await executeProjectProgressSync({
      ...input,
      operationMetrics,
      ...(cancellation.signal ? { cancellationSignal: cancellation.signal } : {}),
    });
  } finally {
    cancellation.dispose();
  }
}

async function executeProjectProgressSync(
  input: ProjectProgressSyncInput & {
    operationMetrics: OperationMetricsRecorder;
    cancellationSignal?: AbortSignal;
  },
): Promise<ProjectProgressSyncReport> {
  const writeMode = input.writeMode ?? "dry-run";
  const concurrency = resolveConcurrency(input.concurrency);
  if (writeMode === "unsafe-test" && input.projectId === undefined) {
    throw new Error("unsafe-test 写入必须指定单个 projectId。");
  }
  const writer = writeMode !== "dry-run"
    ? requireOaWriter(input.oaClient)
    : null;
  const writableStore = writeMode !== "dry-run"
    ? requireWritableStore(input.store)
    : null;
  await emitTrace(input.trace, {
    eventKey: "load_projects",
    sequence: 100,
    phase: "load_projects",
    status: "running",
    title: "读取 OA 项目列表",
  });
  const listedProjects = await input.oaClient.listProjects(input.cancellationSignal);
  const projects = input.projectId === undefined
    ? listedProjects
    : listedProjects.filter((project) => project.id === input.projectId);
  await emitTrace(input.trace, {
    eventKey: "load_projects",
    sequence: 100,
    phase: "load_projects",
    status: "succeeded",
    title: "读取 OA 项目列表",
    message: `已读取 ${projects.length} 个候选项目`,
    progressCurrent: projects.length,
    progressTotal: projects.length,
  });
  const githubLimiter = new AsyncSemaphore(concurrency.github);
  const agentLimiter = new AsyncSemaphore(concurrency.agent);
  const oaWriteLimiter = new AsyncSemaphore(concurrency.oaWrite);
  const entries: ProjectEntry[] = [];
  const repositoriesByKey = new Map<string, GitHubRepositoryIdentity>();
  const reports: ProjectProgressProjectReport[] = [];
  let mutationsApplied = 0;
  let cancelled = false;

  await emitTrace(input.trace, {
    eventKey: "discover_repositories",
    sequence: 200,
    phase: "discover_repositories",
    status: "running",
    title: "解析项目与 GitHub 仓库",
    progressCurrent: 0,
    progressTotal: projects.length,
  });
  const discoveryProjects = await resolveDiscoveryProjects(
    projects,
    input.oaClient,
    input.projectDetailCompatibilityMode ?? false,
    input.cancellationSignal,
  );
  for (const discovery of discoveryProjects) {
    const listedProject = discovery.listedProject;
    if (input.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    if (listedProject.status === "archived") {
      entries.push({ kind: "report", report: archivedReport(listedProject) });
      continue;
    }

    if (discovery.error !== undefined) {
      entries.push({
        kind: "report",
        report: incompleteReport(
          listedProject,
          `project_detail_failed:${errorMessage(discovery.error)}`,
        ),
      });
      continue;
    }
    const project = discovery.project;
    if (project.status === "archived") {
      entries.push({ kind: "report", report: archivedReport(project) });
      continue;
    }
    if (project.githubUrls.length === 0) {
      entries.push({
        kind: "report",
        report: {
          projectId: project.id,
          projectName: project.projectName,
          currentStatus: project.status,
          targetStatus: project.status,
          outcome: "no_github_urls",
          warnings: ["no_github_urls"],
          summaries: [],
        },
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
      entries.push({
        kind: "report",
        report: {
          projectId: project.id,
          projectName: project.projectName,
          currentStatus: project.status,
          targetStatus: project.status,
          outcome: "invalid_github_urls",
          warnings: [`invalid_github_url:${errorMessage(error)}`],
          summaries: [],
        },
      });
      continue;
    }
    const prepared: PreparedProject = {
      project: project as OaProject & { status: Exclude<ProjectStatus, "archived"> },
      repositories,
    };
    entries.push({ kind: "project", prepared });
    for (const repository of repositories) {
      repositoriesByKey.set(repository.fullName.toLowerCase(), repository);
    }
  }
  await emitTrace(input.trace, {
    eventKey: "discover_repositories",
    sequence: 200,
    phase: "discover_repositories",
    status: cancelled ? "cancelled" : "succeeded",
    title: "解析项目与 GitHub 仓库",
    message: `发现 ${repositoriesByKey.size} 个唯一仓库`,
    progressCurrent: entries.length,
    progressTotal: projects.length,
    metadataSanitized: {
      repositories_discovered: repositoriesByKey.size,
      archived_or_skipped_projects: entries.filter((entry) => entry.kind === "report").length,
    },
  });

  const repositorySnapshots = new Map<string, RepositorySnapshotResult>();
  await emitTrace(input.trace, {
    eventKey: "read_github",
    sequence: 300,
    phase: "read_github",
    status: "running",
    title: "读取 GitHub 分支与 Commit",
    progressCurrent: 0,
    progressTotal: repositoriesByKey.size,
  });
  let completedRepositoryReads = 0;
  let readTraceQueue = Promise.resolve();
  const queueReadTrace = (event: ProjectProgressTraceEvent) => {
    readTraceQueue = readTraceQueue.then(() => emitTrace(input.trace, event));
    return readTraceQueue;
  };
  await Promise.all([...repositoriesByKey.entries()].map(async ([key, repository]) => {
    let latestProgress: GitHubRepositoryReadProgress = {
      branchesCompleted: 0,
      branchesTotal: null,
      commitsRead: 0,
    };
    try {
      const snapshot = await githubLimiter.run(
        async () => {
          await queueReadTrace({
            eventKey: `read_github:${key}`,
            sequence: 310,
            phase: "read_github_repository",
            status: "running",
            title: "读取 GitHub 仓库",
            message: "正在读取分支列表",
            repositoryFullName: repository.fullName,
          });
          return input.githubReader.readRepository(
            repository,
            input.observedAt,
            input.cancellationSignal,
            async (progress) => {
              latestProgress = progress;
              await queueReadTrace(repositoryReadTraceEvent(
                repository,
                key,
                progress,
                "running",
              ));
            },
          );
        },
        input.cancellationSignal,
      );
      repositorySnapshots.set(key, { snapshot });
      await queueReadTrace(repositoryReadTraceEvent(
        repository,
        key,
        latestProgress,
        "succeeded",
      ));
    } catch (error) {
      repositorySnapshots.set(key, { error });
      await queueReadTrace({
        ...repositoryReadTraceEvent(
          repository,
          key,
          latestProgress,
          input.cancellationSignal?.aborted ? "cancelled" : "failed",
        ),
        message: input.cancellationSignal?.aborted
          ? "已停止读取"
          : "仓库读取失败",
      });
    } finally {
      completedRepositoryReads += 1;
      await queueReadTrace({
        eventKey: "read_github",
        sequence: 300,
        phase: "read_github",
        status: "running",
        title: "读取 GitHub 分支与 Commit",
        message: `已完成 ${completedRepositoryReads}/${repositoriesByKey.size} 个仓库`,
        progressCurrent: completedRepositoryReads,
        progressTotal: repositoriesByKey.size,
        repositoryFullName: repository.fullName,
      });
    }
  }));
  cancelled ||= input.cancellationSignal?.aborted ?? false;
  const repositoryReadFailures = [...repositorySnapshots.values()].filter(
    (result) => result.error !== undefined,
  ).length;
  const repositoryConfigurationErrors = [...repositorySnapshots.values()].filter(
    (result) => result.error !== undefined && isRepositoryConfigurationError(result.error),
  ).length;
  await emitTrace(input.trace, {
    eventKey: "read_github",
    sequence: 300,
    phase: "read_github",
    status: cancelled
      ? "cancelled"
      : repositoryReadFailures > 0
        ? "fallback"
        : "succeeded",
    title: "读取 GitHub 分支与 Commit",
    message: repositoryReadFailures > 0
      ? `${repositoryReadFailures} 个仓库读取失败，关联项目将跳过写入`
      : `已完成 ${repositorySnapshots.size} 个仓库读取`,
    progressCurrent: repositorySnapshots.size,
    progressTotal: repositoriesByKey.size,
    metadataSanitized: {
      repository_read_failures: repositoryReadFailures,
      repository_configuration_errors: repositoryConfigurationErrors,
    },
  });

  const currentBusinessDate = formatDateInTimeZone(
    input.observedAt,
    PROJECT_PROGRESS_TIME_ZONE,
  );
  const evaluations = new Map<number, ProjectEvaluation>();
  const repositoryTasks = new Map<string, RepositorySummaryTask>();
  for (const entry of entries) {
    if (entry.kind !== "project") {
      continue;
    }
    const { project, repositories } = entry.prepared;
    const warnings: string[] = [];
    const snapshots = repositories.map((repository) => {
      const result = repositorySnapshots.get(repository.fullName.toLowerCase());
      if (result?.snapshot) {
        return result.snapshot;
      }
      warnings.push(repositoryReadWarning(repository.fullName, result?.error));
      return incompleteRepositorySnapshot(repository);
    });
    const decision = decideProjectStatus({
      currentStatus: project.status,
      observedAt: input.observedAt,
      repositories: snapshots.map((snapshot) => ({
        complete: snapshot.complete,
        lastActivityAt: snapshot.lastActivityAt,
      })),
    });
    const complete = snapshots.every((snapshot) => snapshot.complete);
    const groups: ProjectGroupPlan[] = [];
    if (complete) {
      for (const snapshot of snapshots) {
        input.store?.saveProjectRepositoryWatermark(
          project.id,
          snapshot.repositoryId,
          input.observedAt.toISOString(),
        );
      }
      const allGroups = buildProjectDailyCommitGroups(
        snapshots.flatMap((snapshot) => snapshot.commits),
        input.observedAt,
      );
      const selectedGroups = writeMode === "production"
        ? allGroups.filter((group) => group.summaryDate === currentBusinessDate)
        : allGroups;
      for (const group of selectedGroups) {
        const existing = input.store?.getDailySummaryDraft?.(
          project.id,
          group.summaryDate,
        );
        const cached = !input.forceRegenerateSummaries &&
          existing?.sourceDigest === group.sourceDigest &&
          !isInvalidProjectProgressSummary(existing.summary)
          ? {
            summaryDate: group.summaryDate,
            commitCount: group.commits.length,
            sourceDigest: group.sourceDigest,
            summary: existing.summary,
            aiConfidence: existing.aiConfidence,
            aiNote: existing.aiNote,
          }
          : null;
        groups.push({ group, cached });
        if (cached) {
          continue;
        }
        for (const [repositoryKey, commits] of groupCommitsByRepository(group.commits)) {
          const taskKey = `${repositoryKey}:${group.summaryDate}`;
          if (!repositoryTasks.has(taskKey)) {
            repositoryTasks.set(taskKey, {
              key: taskKey,
              repositoryKey,
              summaryDate: group.summaryDate,
              projectId: project.id,
              projectName: project.projectName,
              commits,
            });
          }
        }
      }
    }
    evaluations.set(project.id, {
      prepared: entry.prepared,
      snapshots,
      warnings,
      complete,
      targetStatus: decision.targetStatus,
      groups,
    });
  }
  await emitTrace(input.trace, {
    eventKey: "prepare_repository_tasks",
    sequence: 400,
    phase: "prepare_repository_tasks",
    status: cancelled ? "cancelled" : "succeeded",
    title: "生成当天仓库总结任务",
    message: `${repositoryTasks.size} 个仓库当天有 Commit，需要运行 Agent`,
    progressCurrent: repositoryTasks.size,
    progressTotal: repositoriesByKey.size,
  });

  const deterministicFallback = new DeterministicProjectProgressSummarizer();
  const repositoryResults = new Map<string, RepositorySummaryResult>();
  let completedRepositoryTasks = 0;
  await emitTrace(input.trace, {
    eventKey: "summarize_repositories",
    sequence: 500,
    phase: "summarize_repositories",
    status: cancelled ? "cancelled" : repositoryTasks.size > 0 ? "running" : "succeeded",
    title: "并发生成仓库 Commit 总结",
    message: repositoryTasks.size > 0
      ? `最多同时运行 ${concurrency.agent} 个 Codex Thread`
      : "当天没有需要调用 AI 的仓库",
    progressCurrent: 0,
    progressTotal: repositoryTasks.size,
  });
  if (!cancelled) {
    await Promise.all([...repositoryTasks.values()].map(async (task) => {
      const finishQueueWait = input.operationMetrics.startQueueWait(
        PROJECT_PROGRESS_ENDPOINTS.modelProjectProgressSummarize,
      );
      try {
        const result = await agentLimiter.run(async () => {
          finishQueueWait();
          await emitTrace(input.trace, {
            eventKey: `repository_summary:${task.repositoryKey}:${task.summaryDate}`,
            sequence: 510,
            phase: "repository_summary",
            status: "running",
            title: "总结仓库 Commit",
            message: task.repositoryKey,
            repositoryFullName: task.repositoryKey,
            metadataSanitized: { commit_count: task.commits.length },
          });
          try {
            const generated = await input.operationMetrics.measure(
              PROJECT_PROGRESS_ENDPOINTS.modelProjectProgressSummarize,
              () => input.summarizer.summarize({
                projectId: task.projectId,
                projectName: task.projectName,
                repositoryFullName: task.repositoryKey,
                summaryDate: task.summaryDate,
                commits: task.commits,
                ...(input.cancellationSignal ? { signal: input.cancellationSignal } : {}),
              }),
            );
            if (isInvalidProjectProgressSummary(generated.summary)) {
              throw new Error("总结器输出的内容不是最终项目总结");
            }
            return {
              key: task.key,
              repositoryKey: task.repositoryKey,
              summary: generated.summary,
              limitations: generated.limitations,
              ...(generated.interaction ? { interaction: generated.interaction } : {}),
              status: generated.interaction?.fallbackUsed
                ? "fallback" as const
                : "succeeded" as const,
            };
          } catch (error) {
            if (input.cancellationSignal?.aborted) {
              throw input.cancellationSignal.reason;
            }
            const fallback = await deterministicFallback.summarize({
              projectId: task.projectId,
              projectName: task.projectName,
              repositoryFullName: task.repositoryKey,
              summaryDate: task.summaryDate,
              commits: task.commits,
            });
            return {
              key: task.key,
              repositoryKey: task.repositoryKey,
              summary: fallback.summary,
              limitations: [
                `仓库 Agent 总结失败，已使用确定性兜底:${errorMessage(error)}`,
              ],
              status: "fallback" as const,
            };
          }
        }, input.cancellationSignal);
        repositoryResults.set(task.key, result);
        completedRepositoryTasks += 1;
        await emitTrace(input.trace, {
          eventKey: `repository_summary:${task.repositoryKey}:${task.summaryDate}`,
          sequence: 510,
          phase: "repository_summary",
          status: result.status,
          title: "总结仓库 Commit",
          message: result.status === "fallback"
            ? `${task.repositoryKey} 使用确定性兜底总结`
            : `${task.repositoryKey} 总结完成`,
          progressCurrent: task.commits.length,
          progressTotal: task.commits.length,
          repositoryFullName: task.repositoryKey,
          metadataSanitized: { commit_count: task.commits.length },
        });
        await emitTrace(input.trace, {
          eventKey: "summarize_repositories",
          sequence: 500,
          phase: "summarize_repositories",
          status: completedRepositoryTasks === repositoryTasks.size
            ? "succeeded"
            : "running",
          title: "并发生成仓库 Commit 总结",
          message: `已完成 ${completedRepositoryTasks}/${repositoryTasks.size} 个仓库`,
          progressCurrent: completedRepositoryTasks,
          progressTotal: repositoryTasks.size,
        });
      } catch (error) {
        finishQueueWait();
        if (input.cancellationSignal?.aborted) {
          cancelled = true;
          await emitTrace(input.trace, {
            eventKey: `repository_summary:${task.repositoryKey}:${task.summaryDate}`,
            sequence: 510,
            phase: "repository_summary",
            status: "cancelled",
            title: "总结仓库 Commit",
            message: `${task.repositoryKey} 已取消`,
            repositoryFullName: task.repositoryKey,
          });
          return;
        }
        repositoryResults.set(task.key, {
          key: task.key,
          repositoryKey: task.repositoryKey,
          status: "failed",
          error: errorMessage(error),
        });
        completedRepositoryTasks += 1;
        await emitTrace(input.trace, {
          eventKey: `repository_summary:${task.repositoryKey}:${task.summaryDate}`,
          sequence: 510,
          phase: "repository_summary",
          status: "failed",
          title: "总结仓库 Commit",
          message: `${task.repositoryKey} 总结失败`,
          repositoryFullName: task.repositoryKey,
          metadataSanitized: { error_code: "repository_summary_failed" },
        });
      }
    }));
  }

  const failedRepositoryTasks = [...repositoryResults.values()].filter(
    (result) => result.status === "failed",
  ).length;
  await emitTrace(input.trace, {
    eventKey: "summarize_repositories",
    sequence: 500,
    phase: "summarize_repositories",
    status: cancelled
      ? "cancelled"
      : failedRepositoryTasks > 0
        ? "fallback"
        : "succeeded",
    title: "并发生成仓库 Commit 总结",
    message: failedRepositoryTasks > 0
      ? `${failedRepositoryTasks} 个仓库总结失败`
      : `已完成 ${completedRepositoryTasks}/${repositoryTasks.size} 个仓库`,
    progressCurrent: completedRepositoryTasks,
    progressTotal: repositoryTasks.size,
    metadataSanitized: { repository_tasks_failed: failedRepositoryTasks },
  });

  await emitTrace(input.trace, {
    eventKey: "persist_projects",
    sequence: 600,
    phase: "persist_projects",
    status: cancelled ? "cancelled" : "running",
    title: "聚合项目结果并写入 OA",
    progressCurrent: 0,
    progressTotal: entries.length,
  });
  let completedProjectEntries = 0;
  for (const entry of entries) {
    if (entry.kind === "report") {
      reports.push(entry.report);
      completedProjectEntries += 1;
      await emitTrace(input.trace, {
        eventKey: "persist_projects",
        sequence: 600,
        phase: "persist_projects",
        status: "running",
        title: "聚合项目结果并写入 OA",
        message: `已处理 ${completedProjectEntries}/${entries.length} 个项目`,
        progressCurrent: completedProjectEntries,
        progressTotal: entries.length,
      });
      continue;
    }
    const evaluation = evaluations.get(entry.prepared.project.id)!;
    const { project } = entry.prepared;
    const summaries: ProjectProgressSummaryProposal[] = [];
    if (evaluation.complete) {
      for (const plan of evaluation.groups) {
        if (plan.cached) {
          summaries.push(plan.cached);
          continue;
        }
        const expectedRepositoryKeys = [...groupCommitsByRepository(
          plan.group.commits,
        ).keys()].sort();
        const repositoryGroupResults = expectedRepositoryKeys
          .map((repositoryKey) => repositoryResults.get(
            `${repositoryKey}:${plan.group.summaryDate}`,
          ))
          .filter((result): result is RepositorySummaryResult => result !== undefined);
        if (
          repositoryGroupResults.length !== expectedRepositoryKeys.length ||
          repositoryGroupResults.some((result) => result.status === "failed")
        ) {
          evaluation.complete = false;
          evaluation.warnings.push(
            `repository_summary_incomplete:${plan.group.summaryDate}`,
          );
          for (const result of repositoryGroupResults) {
            if (result.status === "failed") {
              evaluation.warnings.push(
                `repository_summary_failed:${result.repositoryKey}:${result.error}`,
              );
            }
          }
          continue;
        }
        const results = repositoryGroupResults as SuccessfulRepositorySummaryResult[];
        for (const result of results) {
          if (result.status === "fallback") {
            evaluation.warnings.push(
              `repository_summary_fallback:${result.repositoryKey}:${plan.group.summaryDate}`,
            );
          }
        }
        const limitations = [...new Set(results.flatMap((result) => result.limitations))];
        const anomalyCount = plan.group.commits.filter(
          (commit) => commit.timestampAnomaly,
        ).length;
        const aiConfidence = Math.max(
          35,
          90 - anomalyCount * 10 - (limitations.length > 0 ? 20 : 0),
        );
        const aiNoteParts = [
          `基于 ${evaluation.snapshots.length} 个仓库的 ${plan.group.commits.length} 条提交`,
          ...(anomalyCount > 0 ? [`${anomalyCount} 条提交时间异常`] : []),
          ...limitations,
        ];
        const repositoryInteractions = results
          .filter((result): result is SuccessfulRepositorySummaryResult & {
            interaction: ProjectProgressAiInteraction;
          } => result.interaction !== undefined)
          .map((result) => ({
            repositoryKey: result.repositoryKey,
            interaction: result.interaction,
          }));
        const proposal: ProjectProgressSummaryProposal = {
          summaryDate: plan.group.summaryDate,
          commitCount: plan.group.commits.length,
          sourceDigest: plan.group.sourceDigest,
          summary: combineRepositorySummaries(results),
          aiConfidence,
          aiNote: `${aiNoteParts.join("；")}。`,
          ...(repositoryInteractions.length > 0
            ? {
              repositoryInteractions,
              interaction: repositoryInteractions[0]!.interaction,
            }
            : {}),
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

    let projectMutationsApplied = 0;
    if (input.shouldCancel?.()) {
      cancelled = true;
      evaluation.warnings.push("cancel_requested");
    } else if (writer && writableStore && evaluation.complete) {
      try {
        const applied = await applyMutations({
          project,
          observedAt: input.observedAt,
          targetStatus: evaluation.targetStatus,
          summaries,
          writer,
          writeLimiter: oaWriteLimiter,
          cancellationSignal: input.cancellationSignal,
          store: writableStore,
          summaryWritePolicy: input.summaryWritePolicy ?? "managed-only",
          warnings: evaluation.warnings,
          shouldCancel: input.shouldCancel,
        });
        mutationsApplied += applied;
        projectMutationsApplied += applied;
      } catch (error) {
        if (error instanceof ProjectProgressLeaseLostError) {
          throw error;
        }
        evaluation.warnings.push(`write_failed:${errorMessage(error)}`);
      }
      if (input.shouldCancel?.()) {
        cancelled = true;
        if (!evaluation.warnings.includes("cancel_requested")) {
          evaluation.warnings.push("cancel_requested");
        }
      }
    }

    reports.push({
      projectId: project.id,
      projectName: project.projectName,
      currentStatus: project.status,
      targetStatus: evaluation.targetStatus,
      outcome: !evaluation.complete
        ? "incomplete"
        : summaries.length === 0
          ? "no_commits"
          : "evaluated",
      warnings: evaluation.warnings,
      summaries,
      repositoryCount: evaluation.snapshots.length,
      commitCount: summaries.reduce((total, summary) => total + summary.commitCount, 0),
      mutationsApplied: projectMutationsApplied,
    });
    completedProjectEntries += 1;
    await emitTrace(input.trace, {
      eventKey: "persist_projects",
      sequence: 600,
      phase: "persist_projects",
      status: "running",
      title: "聚合项目结果并写入 OA",
      message: `已处理 ${completedProjectEntries}/${entries.length} 个项目`,
      progressCurrent: completedProjectEntries,
      progressTotal: entries.length,
      projectId: project.id,
    });
    if (cancelled) {
      break;
    }
  }
  await emitTrace(input.trace, {
    eventKey: "persist_projects",
    sequence: 600,
    phase: "persist_projects",
    status: cancelled ? "cancelled" : "succeeded",
    title: "聚合项目结果并写入 OA",
    message: `已处理 ${completedProjectEntries}/${entries.length} 个项目`,
    progressCurrent: completedProjectEntries,
    progressTotal: entries.length,
    metadataSanitized: { mutations_applied: mutationsApplied },
  });

  const repositoriesWithCommits = new Set(
    [...repositorySnapshots.entries()]
      .filter(([, result]) => result.snapshot?.complete &&
        buildProjectDailyCommitGroups(
          result.snapshot.commits,
          input.observedAt,
        ).some((group) => group.summaryDate === currentBusinessDate))
      .map(([repositoryKey]) => repositoryKey),
  );

  return {
    mode: writeMode === "production"
      ? "production-write"
      : writeMode === "unsafe-test"
        ? "unsafe-test-write"
        : "dry-run",
    observedAt: input.observedAt.toISOString(),
    mutationsApplied,
    retryRecommended: reports.some(projectNeedsRetry),
    cancelled,
    metrics: {
      repositoriesDiscovered: repositoriesByKey.size,
      repositoriesWithCommits: repositoriesWithCommits.size,
      repositoryTasksTotal: repositoryTasks.size,
      repositoryTasksSucceeded: [...repositoryResults.values()].filter(
        (result) => result.status === "succeeded",
      ).length,
      repositoryTasksFallback: [...repositoryResults.values()].filter(
        (result) => result.status === "fallback",
      ).length,
      repositoryTasksFailed: [...repositoryResults.values()].filter(
        (result) => result.status === "failed",
      ).length,
      githubPeakConcurrency: input.githubRequestLimiter?.metrics.peakActive ??
        githubLimiter.metrics.peakActive,
      agentPeakConcurrency: agentLimiter.metrics.peakActive,
      oaWritePeakConcurrency: oaWriteLimiter.metrics.peakActive,
    },
    operationMetrics: input.operationMetrics.snapshot(),
    projects: reports,
  };
}

type ProjectDiscovery = {
  listedProject: OaProject;
  project: OaProject;
  error?: undefined;
} | {
  listedProject: OaProject;
  project: OaProject;
  error: unknown;
};

async function resolveDiscoveryProjects(
  projects: OaProject[],
  reader: ProjectProgressOaReader,
  compatibilityMode: boolean,
  signal?: AbortSignal,
): Promise<ProjectDiscovery[]> {
  if (!compatibilityMode) {
    return projects.map((project) => ({ listedProject: project, project }));
  }
  const detailLimiter = new AsyncSemaphore(4);
  return await Promise.all(projects.map(async (listedProject): Promise<ProjectDiscovery> => {
    if (listedProject.status === "archived") {
      return { listedProject, project: listedProject };
    }
    try {
      const project = await detailLimiter.run(
        () => reader.getProject(listedProject.id, signal),
        signal,
      );
      return { listedProject, project };
    } catch (error) {
      return { listedProject, project: listedProject, error };
    }
  }));
}

function createCancellationMonitor(
  shouldCancel: (() => boolean) | undefined,
): { signal?: AbortSignal; dispose(): void } {
  if (!shouldCancel) {
    return { dispose: () => undefined };
  }
  const controller = new AbortController();
  const poll = () => {
    try {
      if (shouldCancel() && !controller.signal.aborted) {
        controller.abort(new Error("cancel_requested"));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    }
  };
  poll();
  const timer = setInterval(poll, 10);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => clearInterval(timer),
  };
}

function resolveConcurrency(
  value: ProjectProgressConcurrency | undefined,
): ProjectProgressConcurrency {
  const resolved = value ?? { github: 6, agent: 2, oaWrite: 1 };
  if (
    !Number.isInteger(resolved.github) ||
    resolved.github < 1 ||
    !Number.isInteger(resolved.agent) ||
    resolved.agent < 1 ||
    resolved.oaWrite !== 1
  ) {
    throw new Error("项目进度并发配置无效，必须满足 GitHub>=1、Agent>=1、OA 写入=1。");
  }
  return resolved;
}

function repositoryReadTraceEvent(
  repository: GitHubRepositoryIdentity,
  repositoryKey: string,
  progress: GitHubRepositoryReadProgress,
  status: ProjectProgressTraceEvent["status"],
): ProjectProgressTraceEvent {
  const total = progress.branchesTotal;
  return {
    eventKey: `read_github:${repositoryKey}`,
    sequence: 310,
    phase: "read_github_repository",
    status,
    title: "读取 GitHub 仓库",
    message: total === null
      ? "正在读取分支列表"
      : `已读取 ${progress.branchesCompleted}/${total} 个分支，发现 ${progress.commitsRead} 条 Commit`,
    ...(total === null
      ? {}
      : {
          progressCurrent: progress.branchesCompleted,
          progressTotal: total,
        }),
    repositoryFullName: repository.fullName,
    metadataSanitized: {
      commits_read: progress.commitsRead,
    },
  };
}

async function emitTrace(
  sink: ProjectProgressTraceSink | undefined,
  event: ProjectProgressTraceEvent,
): Promise<void> {
  if (!sink) {
    return;
  }
  try {
    await sink(event);
  } catch (error) {
    if (isDefinitiveLeaseLossError(error)) {
      throw error;
    }
    return;
  }
}

function incompleteRepositorySnapshot(
  repository: GitHubRepositoryIdentity,
): GitHubRepositorySnapshot {
  return {
    repositoryId: -1,
    fullName: repository.fullName,
    canonicalUrl: repository.canonicalUrl,
    complete: false,
    lastActivityAt: null,
    commits: [],
  };
}

function groupCommitsByRepository(
  commits: NormalizedProjectProgressCommit[],
): Map<string, NormalizedProjectProgressCommit[]> {
  const grouped = new Map<string, NormalizedProjectProgressCommit[]>();
  for (const commit of commits) {
    const key = commit.repositoryFullName.toLowerCase();
    const repositoryCommits = grouped.get(key) ?? [];
    repositoryCommits.push(commit);
    grouped.set(key, repositoryCommits);
  }
  return grouped;
}

function combineRepositorySummaries(
  results: SuccessfulRepositorySummaryResult[],
): string {
  if (results.length === 1) {
    return results[0]!.summary;
  }
  const parts = results
    .map((result) => result.summary.replace(/[。；;]+$/u, "").trim())
    .filter(Boolean);
  return parts.length > 0 ? `${parts.join("；")}。` : "完成当日代码更新。";
}

function projectNeedsRetry(report: ProjectProgressProjectReport): boolean {
  return report.warnings.some((warning) =>
    warning.startsWith("repository_summary_fallback:") ||
    warning.startsWith("repository_summary_failed:") ||
    warning.startsWith("repository_summary_incomplete:")
  );
}

function repositoryReadWarning(repositoryFullName: string, error: unknown): string {
  const kind = isRepositoryConfigurationError(error)
    ? "repository_configuration_error"
    : "repository_read_failed";
  return `${kind}:${repositoryFullName}:${errorMessage(error)}`;
}

function isRepositoryConfigurationError(error: unknown): boolean {
  return error instanceof GitHubRequestError && error.status === 404;
}

async function applyMutations(input: {
  project: OaProject;
  observedAt: Date;
  targetStatus: Exclude<ProjectStatus, "archived">;
  summaries: ProjectProgressSummaryProposal[];
  writer: ProjectProgressOaWriter;
  writeLimiter: AsyncSemaphore;
  cancellationSignal?: AbortSignal;
  store: WritableProjectProgressState;
  summaryWritePolicy: "managed-only" | "manual-overwrite";
  warnings: string[];
  shouldCancel?: () => boolean;
}): Promise<number> {
  const latest = await input.writer.getProject(input.project.id);
  if (latest.status === "archived") {
    input.warnings.push("write_cancelled:project_archived");
    return 0;
  }
  if (repositorySetKey(latest.githubUrls) !== repositorySetKey(input.project.githubUrls)) {
    input.warnings.push("write_cancelled:github_urls_changed");
    return 0;
  }

  let applied = 0;
  if (input.shouldCancel?.()) {
    input.warnings.push("cancel_requested");
    return applied;
  }
  if (latest.status !== input.targetStatus) {
    const intentKey = [
      "project-progress:status",
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
      await input.writeLimiter.run(
        () => input.writer.updateProjectStatus(
          latest.id,
          input.targetStatus,
          latest.version,
        ),
        input.cancellationSignal,
      );
      input.store.markOutboxApplied(intentKey);
      applied += 1;
    } catch (error) {
      if (error instanceof ProjectProgressLeaseLostError) {
        throw error;
      }
      input.warnings.push(`status_write_failed:${errorMessage(error)}`);
    }
  }

  for (const proposal of input.summaries) {
    if (input.shouldCancel?.()) {
      if (!input.warnings.includes("cancel_requested")) {
        input.warnings.push("cancel_requested");
      }
      break;
    }
    try {
      applied += await reconcileSummary({
        projectId: latest.id,
        proposal,
        writer: input.writer,
        writeLimiter: input.writeLimiter,
        cancellationSignal: input.cancellationSignal,
        store: input.store,
        summaryWritePolicy: input.summaryWritePolicy,
        warnings: input.warnings,
      });
    } catch (error) {
      if (error instanceof ProjectProgressLeaseLostError) {
        throw error;
      }
      input.warnings.push(
        `summary_write_failed:${proposal.summaryDate}:${errorMessage(error)}`,
      );
    }
  }
  return applied;
}

async function reconcileSummary(input: {
  projectId: number;
  proposal: ProjectProgressSummaryProposal;
  writer: ProjectProgressOaWriter;
  writeLimiter: AsyncSemaphore;
  cancellationSignal?: AbortSignal;
  store: WritableProjectProgressState;
  summaryWritePolicy: "managed-only" | "manual-overwrite";
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
    let created: OaCommitSummary;
    try {
      created = await input.writeLimiter.run(
        () => input.writer.createCommitSummary({
          projectId: input.projectId,
          summaryDate: input.proposal.summaryDate,
          ...desired,
        }),
        input.cancellationSignal,
      );
    } catch (createError) {
      if (createError instanceof ProjectProgressLeaseLostError) {
        throw createError;
      }
      const raced = await input.writer.listCommitSummaries(
        input.projectId,
        input.proposal.summaryDate,
      );
      if (raced.length !== 1 || !summaryMatchesDesired(raced[0]!, desired)) {
        throw createError;
      }
      markSummaryApplied(input, raced[0]!.id);
      input.store.markOutboxApplied(intentKey);
      input.warnings.push(
        `summary_create_race_adopted:${input.proposal.summaryDate}:${raced[0]!.id}`,
      );
      return 0;
    }
    markSummaryApplied(input, created.id);
    input.store.markOutboxApplied(intentKey);
    return 1;
  }

  const current = existing[0]!;
  const managed = input.store.getManagedSummary(
    input.projectId,
    input.proposal.summaryDate,
  );
  if (!managed && summaryMatchesDesired(current, desired)) {
    markSummaryApplied(input, current.id);
    input.warnings.push(`summary_adopted:${input.proposal.summaryDate}:${current.id}`);
    return 0;
  }
  if (!managed || managed.summaryId !== current.id) {
    if (input.summaryWritePolicy === "manual-overwrite") {
      return await overwriteSummary(input, current, desired);
    }
    input.warnings.push(`summary_unmanaged:${input.proposal.summaryDate}:${current.id}`);
    return 0;
  }
  if (!summaryMatchesAppliedPayload(current, managed)) {
    if (input.summaryWritePolicy === "manual-overwrite") {
      return await overwriteSummary(input, current, desired);
    }
    input.warnings.push(`summary_external_edit:${input.proposal.summaryDate}:${current.id}`);
    return 0;
  }
  if (
    managed.sourceDigest === input.proposal.sourceDigest &&
    summaryMatchesDesired(current, desired)
  ) {
    return 0;
  }

  return await overwriteSummary(input, current, desired);
}

async function overwriteSummary(
  input: {
    projectId: number;
    proposal: ProjectProgressSummaryProposal;
    writer: ProjectProgressOaWriter;
    writeLimiter: AsyncSemaphore;
    cancellationSignal?: AbortSignal;
    store: WritableProjectProgressState;
  },
  current: OaCommitSummary,
  desired: { summary: string; aiConfidence: number; aiNote: string },
): Promise<number> {
  const intentKey = summaryIntentKey("update", input.projectId, input.proposal);
  input.store.enqueueOutbox({
    intentKey,
    operation: "summary.update",
    projectId: input.projectId,
    payload: { summaryId: current.id, ...desired },
  });
  await input.writeLimiter.run(
    () => input.writer.updateCommitSummary(current.id, {
      ...desired,
      expectedVersion: current.version,
    }),
    input.cancellationSignal,
  );
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
  const payloadDigest = createHash("sha256")
    .update(JSON.stringify(summaryPayload(proposal)))
    .digest("hex");
  return [
    "project-progress",
    "summary",
    operation,
    projectId,
    proposal.summaryDate,
    proposal.sourceDigest,
    payloadDigest,
  ].join(":");
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
    throw new Error("项目进度写入需要完整 OA writer。");
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
    throw new Error("项目进度写入需要持久化 outbox 和 managed summary 状态。");
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
