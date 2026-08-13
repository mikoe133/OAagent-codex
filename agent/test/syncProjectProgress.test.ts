import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectProgressExecutionPolicy,
  syncProjectProgress,
  type ProjectProgressTraceEvent,
} from "../src/application/syncProjectProgress.js";
import { GitHubRequestError } from "../src/infrastructure/github/githubClient.js";
import type { GitHubRepositorySnapshot } from "../src/infrastructure/github/githubTypes.js";
import { AutomationLeaseLostError } from "../src/infrastructure/oa/automationOaClient.js";
import { ProjectProgressLeaseLostError } from "../src/infrastructure/oa/projectProgressOaClient.js";
import { OperationMetricsRecorder } from "../src/infrastructure/observability/operationMetrics.js";

describe("syncProjectProgress", () => {
  it("records model request outcomes and semaphore queue wait", async () => {
    const metrics = new OperationMetricsRecorder();
    const projects = [1, 2, 3].map((id) => ({
      id,
      projectName: `project-${id}`,
      status: "updating" as const,
      githubUrls: [`https://github.com/example/repository-${id}`],
    }));
    const report = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      operationMetrics: metrics,
      concurrency: { github: 3, agent: 1, oaWrite: 1 },
      oaClient: {
        listProjects: async () => projects,
        getProject: async (projectId) => projects[projectId - 1]!,
      },
      githubReader: {
        readRepository: async (repository) => ({
          repositoryId: Number(repository.repository.split("-").at(-1)),
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(
            Number(repository.repository.split("-").at(-1)),
            repository.fullName,
            `sha-${repository.repository}`,
            "2026-07-24T01:00:00.000Z",
          )],
        }),
      },
      summarizer: {
        summarize: async (input) => {
          await delay(2);
          if (input.repositoryFullName.endsWith("-2")) {
            throw new Error("model unavailable");
          }
          return { summary: "完成更新。", limitations: [] };
        },
      },
    });

    const model = report.operationMetrics.find(
      (item) => item.endpoint === "model.project-progress.summarize",
    );
    assert.deepEqual({
      requests: model?.requests,
      successes: model?.successes,
      failures: model?.failures,
      queueSamples: model?.queueWaitMs?.count,
    }, {
      requests: 3,
      successes: 2,
      failures: 1,
      queueSamples: 3,
    });
    assert.equal(report.retryRecommended, true);
    assert.match(
      report.projects[1]?.warnings.join(" ") ?? "",
      /repository_summary_fallback:example\/repository-2:2026-07-24/,
    );
  });

  it("classifies a punctuation-only repository summary as retryable failure", async () => {
    const project = {
      id: 4,
      projectName: "punctuation-summary",
      status: "updating" as const,
      githubUrls: ["https://github.com/example/punctuation-summary"],
    };
    const report = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 4,
          fullName: "example/punctuation-summary",
          canonicalUrl: "https://github.com/example/punctuation-summary",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(
            4,
            "example/punctuation-summary",
            "sha-punctuation",
            "2026-07-24T01:00:00.000Z",
          )],
        }),
      },
      summarizer: {
        summarize: async () => ({ summary: "...", limitations: [] }),
      },
    });

    assert.equal(report.retryRecommended, true);
    assert.equal(report.metrics.repositoryTasksFallback, 1);
    assert.match(
      report.projects[0]?.warnings.join(" ") ?? "",
      /repository_summary_fallback:example\/punctuation-summary:2026-07-24/,
    );
    assert.notEqual(report.projects[0]?.summaries[0]?.summary, "...");
  });

  it("fans out one Agent summary per active repository with 6/2/1 concurrency", async () => {
    const repositoryCount = 8;
    const project = {
      id: 1,
      projectName: "parallel-project",
      status: "updating" as const,
      githubUrls: Array.from(
        { length: repositoryCount },
        (_, index) => `https://github.com/example/repository-${index + 1}`,
      ),
    };
    let activeGitHubReads = 0;
    let peakGitHubReads = 0;
    let activeAgentRuns = 0;
    let peakAgentRuns = 0;
    const summarizedRepositories: string[] = [];
    const traceEvents: ProjectProgressTraceEvent[] = [];

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      concurrency: { github: 6, agent: 2, oaWrite: 1 },
      trace: (event) => {
        traceEvents.push(event);
      },
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async (repository) => {
          activeGitHubReads += 1;
          peakGitHubReads = Math.max(peakGitHubReads, activeGitHubReads);
          await delay(10);
          activeGitHubReads -= 1;
          const repositoryId = Number(repository.repository.split("-").at(-1));
          return {
            repositoryId,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: "2026-07-24T01:00:00.000Z",
            commits: [commit(
              repositoryId,
              repository.fullName,
              `sha-${repositoryId}`,
              "2026-07-24T01:00:00.000Z",
            )],
          };
        },
      },
      summarizer: {
        summarize: async (summaryInput) => {
          const repositories = [...new Set(
            summaryInput.commits.map((item) => item.repositoryFullName),
          )];
          assert.equal(repositories.length, 1);
          summarizedRepositories.push(repositories[0]!);
          activeAgentRuns += 1;
          peakAgentRuns = Math.max(peakAgentRuns, activeAgentRuns);
          await delay(10);
          activeAgentRuns -= 1;
          return { summary: `完成 ${repositories[0]} 更新。`, limitations: [] };
        },
      },
    });

    assert.equal(peakGitHubReads, 6);
    assert.equal(peakAgentRuns, 2);
    assert.equal(summarizedRepositories.length, repositoryCount);
    assert.equal(new Set(summarizedRepositories).size, repositoryCount);
    assert.equal(result.projects[0]?.summaries.length, 1);
    assert.equal(result.projects[0]?.summaries[0]?.commitCount, repositoryCount);
    assert.equal(result.metrics.repositoriesWithCommits, repositoryCount);
    assert.equal(result.metrics.githubPeakConcurrency, 6);
    assert.equal(result.metrics.agentPeakConcurrency, 2);
    assert.equal(result.metrics.oaWritePeakConcurrency, 0);
    assert.deepEqual(
      traceEvents
        .filter((event) => event.eventKey === "read_github")
        .map((event) => ({
          status: event.status,
          progressCurrent: event.progressCurrent,
          progressTotal: event.progressTotal,
        })),
      [
        { status: "running", progressCurrent: 0, progressTotal: repositoryCount },
        ...Array.from({ length: repositoryCount }, (_, index) => ({
          status: "running" as const,
          progressCurrent: index + 1,
          progressTotal: repositoryCount,
        })),
        { status: "succeeded", progressCurrent: repositoryCount, progressTotal: repositoryCount },
      ],
    );
    assert.equal(
      traceEvents.filter((event) =>
        event.phase === "repository_summary" && event.status === "succeeded"
      ).length,
      repositoryCount,
    );
    assert.equal(
      traceEvents.findLast((event) => event.eventKey === "summarize_repositories")?.status,
      "succeeded",
    );
  });

  it("summarizes a shared repository once and fans the result into both projects", async () => {
    const projects = [1, 2].map((id) => ({
      id,
      projectName: `project-${id}`,
      status: "updating" as const,
      githubUrls: ["https://github.com/example/shared"],
    }));
    let summaries = 0;

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      concurrency: { github: 6, agent: 2, oaWrite: 1 },
      oaClient: {
        listProjects: async () => projects,
        getProject: async (projectId) => projects.find((project) => project.id === projectId)!,
      },
      githubReader: {
        readRepository: async (repository) => ({
          repositoryId: 99,
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(99, repository.fullName, "shared", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: {
        summarize: async () => {
          summaries += 1;
          return { summary: "完成共享仓库更新。", limitations: [] };
        },
      },
    });

    assert.equal(summaries, 1);
    assert.equal(result.projects.length, 2);
    assert.deepEqual(
      result.projects.map((item) => item.summaries[0]?.summary),
      ["完成共享仓库更新。", "完成共享仓库更新。"],
    );
  });

  it("cancels queued repository Threads when the worker loses its lease", async () => {
    const project = {
      id: 3,
      projectName: "cancelled-project",
      status: "updating" as const,
      githubUrls: Array.from(
        { length: 4 },
        (_, index) => `https://github.com/example/cancel-${index + 1}`,
      ),
    };
    let cancelRequested = false;
    let summariesStarted = 0;

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      concurrency: { github: 6, agent: 1, oaWrite: 1 },
      shouldCancel: () => cancelRequested,
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async (repository) => {
          const repositoryId = Number(repository.repository.split("-").at(-1));
          return {
            repositoryId,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: "2026-07-24T01:00:00.000Z",
            commits: [commit(
              repositoryId,
              repository.fullName,
              `sha-${repositoryId}`,
              "2026-07-24T01:00:00.000Z",
            )],
          };
        },
      },
      summarizer: {
        summarize: async (summaryInput) => {
          summariesStarted += 1;
          cancelRequested = true;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 30);
            summaryInput.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(summaryInput.signal?.reason);
            }, { once: true });
          });
          return { summary: "must be cancelled", limitations: [] };
        },
      },
    });

    assert.equal(summariesStarted, 1);
    assert.equal(result.cancelled, true);
    assert.equal(result.metrics.repositoryTasksSucceeded, 0);
  });

  it("never reads GitHub for archived projects", async () => {
    let githubReads = 0;
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: {
        listProjects: async () => [
          {
            id: 7,
            projectName: "archived",
            status: "archived",
            githubUrls: ["https://github.com/example/private"],
          },
        ],
        getProject: async () => {
          throw new Error("archived list entries do not need a detail read");
        },
      },
      githubReader: {
        readRepository: async () => {
          githubReads += 1;
          throw new Error("must not be called");
        },
      },
      summarizer: {
        summarize: async () => ({ summary: "unused", limitations: [] }),
      },
    });

    assert.equal(githubReads, 0);
    assert.equal(result.projects[0]?.outcome, "archived");
  });

  it("uses complete project list rows without discovery detail reads", async () => {
    let detailReads = 0;
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: {
        listProjects: async () => [{
          id: 70,
          projectName: "list-is-complete",
          status: "maintenance",
          githubUrls: [],
          version: 3,
        }],
        getProject: async () => {
          detailReads += 1;
          throw new Error("default discovery must not read project details");
        },
      },
      githubReader: {
        readRepository: async () => {
          throw new Error("must not read GitHub without repositories");
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
    });

    assert.equal(detailReads, 0);
    assert.equal(result.projects[0]?.outcome, "no_github_urls");
  });

  it("bounds compatibility project detail reads at four", async () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      projectName: `legacy-${index + 1}`,
      status: "maintenance" as const,
      githubUrls: [],
    }));
    let active = 0;
    let peak = 0;
    let reads = 0;
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectDetailCompatibilityMode: true,
      oaClient: {
        listProjects: async () => projects,
        getProject: async (projectId) => {
          reads += 1;
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return projects[projectId - 1]!;
        },
      },
      githubReader: {
        readRepository: async () => {
          throw new Error("must not read GitHub without repositories");
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
    });

    assert.equal(reads, 12);
    assert.equal(peak, 4);
    assert.equal(result.projects.length, 12);
  });

  it("skips repository Threads without current-day commits but still applies maintenance", async () => {
    const statusUpdates: string[] = [];
    let summariesStarted = 0;
    const project = {
      id: 71,
      projectName: "stale-project",
      status: "updating" as const,
      githubUrls: ["https://github.com/example/stale"],
    };

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      writeMode: "production",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async (_projectId, status) => {
          statusUpdates.push(status);
        },
        listCommitSummaries: async () => [],
        createCommitSummary: async () => {
          throw new Error("must not create a summary without current-day commits");
        },
        updateCommitSummary: async () => {
          throw new Error("must not update a summary without current-day commits");
        },
      },
      githubReader: {
        readRepository: async (repository) => ({
          repositoryId: 71,
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: true,
          lastActivityAt: "2026-07-10T01:00:00.000Z",
          commits: [commit(
            71,
            repository.fullName,
            "old-commit",
            "2026-07-10T01:00:00.000Z",
          )],
        }),
      },
      summarizer: {
        summarize: async () => {
          summariesStarted += 1;
          return { summary: "must not run", limitations: [] };
        },
      },
      store: createWritableStore(),
    });

    assert.equal(summariesStarted, 0);
    assert.deepEqual(statusUpdates, ["maintenance"]);
    assert.equal(result.metrics.repositoriesWithCommits, 0);
    assert.equal(result.metrics.repositoryTasksTotal, 0);
    assert.equal(result.metrics.agentPeakConcurrency, 0);
    assert.equal(result.projects[0]?.targetStatus, "maintenance");
    assert.equal(result.projects[0]?.outcome, "no_commits");
    assert.deepEqual(result.projects[0]?.summaries, []);
  });

  it("summarizes the latest historical commit for updating projects and records the scope in trace", async () => {
    const summarizedShas: string[] = [];
    const created: Array<{ projectId: number; summaryDate: string }> = [];
    const traceEvents: ProjectProgressTraceEvent[] = [];
    const updating = {
      id: 72,
      projectName: "historical-latest",
      status: "updating" as const,
      githubUrls: ["https://github.com/example/historical-latest"],
    };
    const maintenance = {
      id: 73,
      projectName: "maintenance-project",
      status: "updating" as const,
      githubUrls: ["https://github.com/example/maintenance-project"],
    };
    let maintenanceRepositoryReads = 0;

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      summaryScope: "latest_commit_of_updating_projects",
      writeMode: "production",
      projectDetailCompatibilityMode: true,
      trace: (event) => {
        traceEvents.push(event);
      },
      oaClient: {
        listProjects: async () => [updating, maintenance],
        getProject: async (projectId) => projectId === updating.id
          ? updating
          : { ...maintenance, status: "maintenance" as const },
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [],
        createCommitSummary: async (input) => {
          created.push({ projectId: input.projectId, summaryDate: input.summaryDate });
          return { id: 720, ...input };
        },
        updateCommitSummary: async () => {
          throw new Error("must not update");
        },
        getCommitSummary: async () => {
          throw new Error("must not read");
        },
      },
      githubReader: {
        readRepository: async (repository) => {
          if (repository.repository === "maintenance-project") {
            maintenanceRepositoryReads += 1;
          }
          return {
            repositoryId: 72,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: "2026-07-20T01:00:00.000Z",
            commits: [
              commit(72, repository.fullName, "older", "2026-07-10T01:00:00.000Z"),
              commit(72, repository.fullName, "latest", "2026-07-20T01:00:00.000Z"),
            ],
          };
        },
      },
      summarizer: {
        summarize: async (input) => {
          summarizedShas.push(...input.commits.map((item) => item.sha));
          return { summary: "历史最新提交总结", limitations: [] };
        },
      },
      store: createWritableStore(),
    });

    assert.deepEqual(summarizedShas, ["latest"]);
    assert.equal(maintenanceRepositoryReads, 0);
    assert.deepEqual(created, [{ projectId: 72, summaryDate: "2026-07-20" }]);
    assert.deepEqual(result.projects.map((project) => project.projectId), [72]);
    assert.equal(result.projects[0]?.summaries[0]?.commitCount, 1);
    assert.equal(
      traceEvents.findLast((event) => event.eventKey === "load_projects")
        ?.metadataSanitized?.summary_scope,
      "latest_commit_of_updating_projects",
    );
  });

  it("reports no commits in latest-commit scope without starting the summarizer", async () => {
    let summariesStarted = 0;
    const project = {
      id: 74,
      projectName: "empty-project",
      status: "updating" as const,
      githubUrls: ["https://github.com/example/empty-project"],
    };

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      summaryScope: "latest_commit_of_updating_projects",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async (repository) => ({
          repositoryId: 74,
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: true,
          lastActivityAt: null,
          commits: [],
        }),
      },
      summarizer: {
        summarize: async () => {
          summariesStarted += 1;
          return { summary: "unused", limitations: [] };
        },
      },
    });

    assert.equal(summariesStarted, 0);
    assert.equal(result.projects[0]?.outcome, "no_commits");
    assert.equal(result.metrics.repositoryTasksTotal, 0);
  });

  it("selects one latest commit across all repositories in latest-commit scope", async () => {
    const summarizedRepositories: string[] = [];
    const project = {
      id: 75,
      projectName: "multi-repository-latest",
      status: "updating" as const,
      githubUrls: [
        "https://github.com/example/older-repository",
        "https://github.com/example/latest-repository",
      ],
    };

    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      summaryScope: "latest_commit_of_updating_projects",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async (repository) => {
          const latest = repository.repository === "latest-repository";
          return {
            repositoryId: latest ? 2 : 1,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: latest
              ? "2026-07-20T01:00:00.000Z"
              : "2026-07-10T01:00:00.000Z",
            commits: [commit(
              latest ? 2 : 1,
              repository.fullName,
              latest ? "latest" : "older",
              latest ? "2026-07-20T01:00:00.000Z" : "2026-07-10T01:00:00.000Z",
            )],
          };
        },
      },
      summarizer: {
        summarize: async (input) => {
          summarizedRepositories.push(input.repositoryFullName);
          assert.deepEqual(input.commits.map((item) => item.sha), ["latest"]);
          return { summary: "跨仓库最新提交总结", limitations: [] };
        },
      },
    });

    assert.deepEqual(summarizedRepositories, ["example/latest-repository"]);
    assert.equal(result.projects[0]?.summaries[0]?.commitCount, 1);
    assert.equal(result.metrics.repositoriesWithCommits, 1);
  });

  it("aggregates a multi-repository day and proposes maintenance recovery", async () => {
    const snapshots = new Map<string, GitHubRepositorySnapshot>([
      [
        "alpha/api",
        {
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        },
      ],
      [
        "alpha/web",
        {
          repositoryId: 2,
          fullName: "alpha/web",
          canonicalUrl: "https://github.com/alpha/web",
          complete: true,
          lastActivityAt: "2026-07-24T02:00:00.000Z",
          commits: [commit(2, "alpha/web", "b", "2026-07-24T02:00:00.000Z")],
        },
      ],
    ]);
    const project = {
      id: 8,
      projectName: "active",
      status: "maintenance" as const,
      githubUrls: [
        "https://github.com/alpha/api",
        "https://github.com/alpha/web.git",
      ],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
      },
      githubReader: {
        readRepository: async (repository) => snapshots.get(repository.fullName)!,
      },
      summarizer: {
        summarize: async (input) => ({
          summary: `共 ${input.commits.length} 条提交`,
          limitations: [],
        }),
      },
    });

    const report = result.projects[0];
    assert.equal(report?.targetStatus, "updating");
    assert.equal(report?.summaries.length, 1);
    assert.equal(report?.summaries[0]?.commitCount, 2);
    assert.equal(report?.summaries[0]?.summary, "共 1 条提交；共 1 条提交。");
    assert.equal(result.mutationsApplied, 0);
  });

  it("does not read GitHub when any configured URL is invalid", async () => {
    let githubReads = 0;
    const project = {
      id: 9,
      projectName: "invalid",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api", "https://evil.example/alpha/web"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: { listProjects: async () => [project], getProject: async () => project },
      githubReader: {
        readRepository: async () => {
          githubReads += 1;
          throw new Error("must not be called");
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
    });

    assert.equal(githubReads, 0);
    assert.equal(result.projects[0]?.outcome, "invalid_github_urls");
  });

  it("does not generate a partial summary when one repository fails", async () => {
    let summaries = 0;
    let watermarks = 0;
    const project = {
      id: 10,
      projectName: "partial",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api", "https://github.com/alpha/web"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: { listProjects: async () => [project], getProject: async () => project },
      githubReader: {
        readRepository: async (repository) => {
          if (repository.repository === "web") {
            throw new Error("forbidden");
          }
          return {
            repositoryId: 1,
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: "2026-07-24T01:00:00.000Z",
            commits: [commit(1, repository.fullName, "a", "2026-07-24T01:00:00.000Z")],
          };
        },
      },
      summarizer: {
        summarize: async () => {
          summaries += 1;
          return { summary: "partial", limitations: [] };
        },
      },
      store: {
        saveProjectRepositoryWatermark: () => {
          watermarks += 1;
        },
      },
    });

    assert.equal(summaries, 0);
    assert.equal(watermarks, 0);
    assert.equal(result.projects[0]?.outcome, "incomplete");
    assert.deepEqual(result.projects[0]?.summaries, []);
    assert.equal(result.retryRecommended, false);
  });

  it("treats a GitHub 404 as a non-retryable repository configuration error", async () => {
    const project = {
      id: 26,
      projectName: "missing repository",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/missing"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: { listProjects: async () => [project], getProject: async () => project },
      githubReader: {
        readRepository: async () => {
          throw new GitHubRequestError("GitHub 请求失败:HTTP 404", 404, null);
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
    });

    assert.equal(result.projects[0]?.outcome, "incomplete");
    assert.match(
      result.projects[0]?.warnings.join(" ") ?? "",
      /repository_configuration_error:alpha\/missing:GitHub 请求失败:HTTP 404/,
    );
    assert.equal(result.retryRecommended, false);
  });

  it("reuses the stored draft when the source digest is unchanged", async () => {
    let summaries = 0;
    let draft: {
      projectId: number;
      summaryDate: string;
      sourceDigest: string;
      summary: string;
      aiConfidence: number;
      aiNote: string;
    } | null = null;
    const project = {
      id: 11,
      projectName: "cached",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const dependencies = {
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      oaClient: { listProjects: async () => [project], getProject: async () => project },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: {
        summarize: async () => {
          summaries += 1;
          return { summary: "cached summary", limitations: [] };
        },
      },
      store: {
        saveProjectRepositoryWatermark: () => undefined,
        saveDailySummaryDraft: (value: NonNullable<typeof draft>) => {
          draft = value;
        },
        getDailySummaryDraft: () => draft,
      },
    };

    await syncProjectProgress(dependencies);
    const cachedResult = await syncProjectProgress(dependencies);

    assert.equal(summaries, 1);
    assert.equal(cachedResult.metrics.repositoriesWithCommits, 1);
    assert.equal(cachedResult.metrics.repositoryTasksTotal, 0);

    draft = {
      ...draft!,
      summary: "候选人提交包含两项更新。我将查看详情以总结进展。",
    };
    const repairedResult = await syncProjectProgress(dependencies);

    assert.equal(summaries, 2);
    assert.equal(repairedResult.metrics.repositoryTasksTotal, 1);

    const regeneratedResult = await syncProjectProgress({
      ...dependencies,
      forceRegenerateSummaries: true,
    });

    assert.equal(summaries, 3);
    assert.equal(regeneratedResult.metrics.repositoryTasksTotal, 1);
  });

  it("applies status and summary writes only in explicit single-project test mode", async () => {
    const mutations: string[] = [];
    const traceEvents: ProjectProgressTraceEvent[] = [];
    const project = {
      id: 12,
      projectName: "write-test",
      status: "maintenance" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 12,
      summaryScope: "today",
      writeMode: "unsafe-test",
      trace: (event) => {
        traceEvents.push(event);
      },
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => {
          mutations.push("status");
        },
        listCommitSummaries: async () => [],
        createCommitSummary: async () => {
          mutations.push("summary");
          return {
            id: 101,
            projectId: 12,
            summaryDate: "2026-07-24",
            summary: "完成登录修复。",
            aiConfidence: 90,
            aiNote: "基于 1 条提交。",
          };
        },
        updateCommitSummary: async () => {
          throw new Error("must not update an unknown summary");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: {
        summarize: async () => ({ summary: "完成登录修复。", limitations: [] }),
      },
      store: createWritableStore(),
    });

    assert.deepEqual(mutations, ["status", "summary"]);
    assert.equal(result.mode, "unsafe-test-write");
    assert.equal(result.mutationsApplied, 2);
    assert.deepEqual(
      traceEvents.findLast((event) => event.eventKey === "load_projects")
        ?.metadataSanitized,
      { summary_scope: "today", project_id: 12 },
    );
  });

  it("cancels test writes when the project becomes archived before mutation", async () => {
    let detailReads = 0;
    let mutations = 0;
    const project = {
      id: 13,
      projectName: "archive-race",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 13,
      writeMode: "unsafe-test",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => {
          detailReads += 1;
          return { ...project, status: "archived" as const };
        },
        updateProjectStatus: async () => {
          mutations += 1;
        },
        listCommitSummaries: async () => [],
        createCommitSummary: async () => {
          mutations += 1;
          throw new Error("must not create");
        },
        updateCommitSummary: async () => {
          mutations += 1;
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "test", limitations: [] }) },
      store: createWritableStore(),
    });

    assert.equal(mutations, 0);
    assert.equal(detailReads, 1);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /archived/);
  });

  it("does not overwrite an existing summary without local ownership", async () => {
    let summaryWrites = 0;
    const project = {
      id: 14,
      projectName: "unmanaged-summary",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 14,
      writeMode: "unsafe-test",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [{
          id: 401,
          projectId: 14,
          summaryDate: "2026-07-24",
          summary: "人工总结",
          aiConfidence: 100,
          aiNote: "",
        }],
        createCommitSummary: async () => {
          summaryWrites += 1;
          throw new Error("must not create");
        },
        updateCommitSummary: async () => {
          summaryWrites += 1;
          throw new Error("must not update");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "AI 总结", limitations: [] }) },
      store: createWritableStore(),
    });

    assert.equal(summaryWrites, 0);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /summary_unmanaged/);
  });

  it("lets a manual run overwrite the unique summary for the same project and date", async () => {
    const updates: Array<{ summaryId: number; summary: string }> = [];
    const project = {
      id: 14,
      projectName: "manual-overwrite",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 14,
      writeMode: "unsafe-test",
      summaryWritePolicy: "manual-overwrite",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [{
          id: 401,
          projectId: 14,
          summaryDate: "2026-07-24",
          summary: "第一次手动总结",
          aiConfidence: 80,
          aiNote: "第一次执行",
          version: 3,
        }],
        createCommitSummary: async () => {
          throw new Error("must not create");
        },
        updateCommitSummary: async (summaryId, update) => {
          updates.push({ summaryId, summary: update.summary });
          return {
            id: summaryId,
            projectId: 14,
            summaryDate: "2026-07-24",
            summary: update.summary,
            aiConfidence: update.aiConfidence,
            aiNote: update.aiNote,
            version: 4,
          };
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: {
        summarize: async () => ({ summary: "第二次手动总结", limitations: [] }),
      },
      store: createWritableStore(),
    });

    assert.deepEqual(updates, [{ summaryId: 401, summary: "第二次手动总结" }]);
    assert.equal(result.mutationsApplied, 1);
    assert.doesNotMatch(result.projects[0]?.warnings.join(" ") ?? "", /summary_unmanaged/);
  });

  it("regenerates manual and retry summaries but only manual runs overwrite", () => {
    assert.deepEqual(projectProgressExecutionPolicy("manual"), {
      forceRegenerateSummaries: true,
      summaryWritePolicy: "manual-overwrite",
    });
    assert.deepEqual(projectProgressExecutionPolicy("retry"), {
      forceRegenerateSummaries: true,
      summaryWritePolicy: "managed-only",
    });
    assert.deepEqual(projectProgressExecutionPolicy("schedule"), {
      forceRegenerateSummaries: false,
      summaryWritePolicy: "managed-only",
    });
  });

  it("reports an applied status when summary reconciliation later fails", async () => {
    const project = {
      id: 15,
      projectName: "partial-write",
      status: "maintenance" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 15,
      writeMode: "unsafe-test",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => {
          throw new Error("summary service unavailable");
        },
        createCommitSummary: async () => {
          throw new Error("must not create");
        },
        updateCommitSummary: async () => {
          throw new Error("must not update");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "AI 总结", limitations: [] }) },
      store: createWritableStore(),
    });

    assert.equal(result.mutationsApplied, 1);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /summary_write_failed/);
    assert.equal(result.retryRecommended, false);
  });

  it("reports missing repositories and project detail failures without side effects", async () => {
    const noRepositories = {
      id: 16,
      projectName: "no-repositories",
      status: "updating" as const,
      githubUrls: [],
    };
    const detailFailure = {
      id: 17,
      projectName: "detail-failure",
      status: "maintenance" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectDetailCompatibilityMode: true,
      oaClient: {
        listProjects: async () => [noRepositories, detailFailure],
        getProject: async (projectId) => {
          if (projectId === 17) {
            throw new Error("OA unavailable");
          }
          return noRepositories;
        },
      },
      githubReader: {
        readRepository: async () => {
          throw new Error("must not read");
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
    });

    assert.deepEqual(result.projects.map((item) => item.outcome), [
      "no_github_urls",
      "incomplete",
    ]);
  });

  it("blocks test writes after detecting an external edit to a managed summary", async () => {
    let updates = 0;
    const project = {
      id: 18,
      projectName: "external-edit",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const store = createWritableStore();
    store.getManagedSummary = () => ({
      summaryId: 501,
      sourceDigest: "old-digest",
      appliedPayload: {
        summary: "Worker 旧值",
        aiConfidence: 90,
        aiNote: "",
      },
    });
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 18,
      writeMode: "unsafe-test",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [{
          id: 501,
          projectId: 18,
          summaryDate: "2026-07-24",
          summary: "人工新值",
          aiConfidence: 100,
          aiNote: "人工编辑",
        }],
        createCommitSummary: async () => {
          throw new Error("must not create");
        },
        updateCommitSummary: async () => {
          updates += 1;
          throw new Error("must not update");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "AI 新值", limitations: [] }) },
      store,
    });

    assert.equal(updates, 0);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /summary_external_edit/);
  });

  it("writes every active project but only the current Beijing day in production", async () => {
    const created: Array<{ projectId: number; summaryDate: string }> = [];
    let activeWrites = 0;
    let peakWrites = 0;
    const projects = [21, 22].map((id) => ({
      id,
      projectName: `project-${id}`,
      status: "updating" as const,
      githubUrls: [`https://github.com/alpha/project-${id}`],
    }));
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      summaryScope: "today",
      writeMode: "production",
      oaClient: {
        listProjects: async () => projects,
        getProject: async (projectId) => projects.find((project) => project.id === projectId)!,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [],
        createCommitSummary: async (input) => {
          activeWrites += 1;
          peakWrites = Math.max(peakWrites, activeWrites);
          await delay(5);
          activeWrites -= 1;
          created.push({ projectId: input.projectId, summaryDate: input.summaryDate });
          return { id: 600 + input.projectId, ...input };
        },
        updateCommitSummary: async () => {
          throw new Error("must not update");
        },
        getCommitSummary: async () => {
          throw new Error("must not read");
        },
      },
      githubReader: {
        readRepository: async (repository) => ({
          repositoryId: Number(repository.repository.split("-").at(-1)),
          fullName: repository.fullName,
          canonicalUrl: repository.canonicalUrl,
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [
            commit(1, repository.fullName, "old", "2026-07-23T01:00:00.000Z"),
            commit(1, repository.fullName, "today", "2026-07-24T01:00:00.000Z"),
          ],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "当天总结", limitations: [] }) },
      store: createWritableStore(),
    });

    assert.equal(result.mode, "production-write");
    assert.deepEqual(created, [
      { projectId: 21, summaryDate: "2026-07-24" },
      { projectId: 22, summaryDate: "2026-07-24" },
    ]);
    assert.deepEqual(result.projects.map((project) => project.summaries.length), [1, 1]);
    assert.equal(peakWrites, 1);
    assert.equal(result.metrics.oaWritePeakConcurrency, 1);
  });

  it("adopts an exact unmanaged summary without overwriting it", async () => {
    let summaryWrites = 0;
    let adoptedSummaryId: number | null = null;
    const project = {
      id: 23,
      projectName: "adoption",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const store = createWritableStore();
    store.markSummaryApplied = (input) => {
      adoptedSummaryId = input.summaryId;
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      writeMode: "production",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [{
          id: 701,
          projectId: 23,
          summaryDate: "2026-07-24",
          summary: "AI 总结",
          aiConfidence: 90,
          aiNote: "基于 1 个仓库的 1 条提交。",
        }],
        createCommitSummary: async () => {
          summaryWrites += 1;
          throw new Error("must not create");
        },
        updateCommitSummary: async () => {
          summaryWrites += 1;
          throw new Error("must not update");
        },
        getCommitSummary: async () => {
          throw new Error("must not read");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "AI 总结", limitations: [] }) },
      store,
    });

    assert.equal(summaryWrites, 0);
    assert.equal(adoptedSummaryId, 701);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /summary_adopted/);
  });

  it("recovers when another worker creates the same summary first", async () => {
    let listReads = 0;
    let adoptedSummaryId: number | null = null;
    const project = {
      id: 24,
      projectName: "create-race",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const store = createWritableStore();
    store.markSummaryApplied = (input) => {
      adoptedSummaryId = input.summaryId;
    };
    const existing = {
      id: 702,
      projectId: 24,
      summaryDate: "2026-07-24",
      summary: "AI 总结",
      aiConfidence: 90,
      aiNote: "基于 1 个仓库的 1 条提交。",
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      writeMode: "production",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => project,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => {
          listReads += 1;
          return listReads === 1 ? [] : [existing];
        },
        createCommitSummary: async () => {
          throw new Error("HTTP 409");
        },
        updateCommitSummary: async () => {
          throw new Error("must not update");
        },
        getCommitSummary: async () => {
          throw new Error("must not read");
        },
      },
      githubReader: {
        readRepository: async () => ({
          repositoryId: 1,
          fullName: "alpha/api",
          canonicalUrl: "https://github.com/alpha/api",
          complete: true,
          lastActivityAt: "2026-07-24T01:00:00.000Z",
          commits: [commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z")],
        }),
      },
      summarizer: { summarize: async () => ({ summary: "AI 总结", limitations: [] }) },
      store,
    });

    assert.equal(adoptedSummaryId, 702);
    assert.match(result.projects[0]?.warnings.join(" ") ?? "", /summary_create_race_adopted/);
    assert.doesNotMatch(result.projects[0]?.warnings.join(" ") ?? "", /summary_write_failed/);
  });

  it("does not retry a project detail failure", async () => {
    const project = {
      id: 25,
      projectName: "retry",
      status: "updating" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      writeMode: "production",
      oaClient: {
        listProjects: async () => [project],
        getProject: async () => {
          throw new Error("OA unavailable");
        },
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [],
        createCommitSummary: async (input) => ({ id: 703, ...input }),
        updateCommitSummary: async (summaryId, input) => ({
          id: summaryId,
          projectId: 25,
          summaryDate: "2026-07-24",
          ...input,
        }),
        getCommitSummary: async () => {
          throw new Error("must not read");
        },
      },
      githubReader: {
        readRepository: async () => {
          throw new Error("must not read");
        },
      },
      summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
      store: createWritableStore(),
    });

    assert.equal(result.retryRecommended, false);
  });

  it("stops all later mutations after definitive project fencing loss", async () => {
    const projects = [31, 32].map((id) => ({
      id,
      projectName: `fenced-${id}`,
      status: "maintenance" as const,
      githubUrls: [`https://github.com/alpha/fenced-${id}`],
      version: 1,
    }));
    let statusWrites = 0;
    let summaryReads = 0;
    let summaryWrites = 0;

    await assert.rejects(
      syncProjectProgress({
        observedAt: new Date("2026-07-24T12:00:00.000Z"),
        writeMode: "production",
        oaClient: {
          listProjects: async () => projects,
          getProject: async (projectId) => projects.find((project) => project.id === projectId)!,
          updateProjectStatus: async () => {
            statusWrites += 1;
            throw new ProjectProgressLeaseLostError(
              "stale worker",
              409,
              "stale_fencing_token",
            );
          },
          listCommitSummaries: async () => {
            summaryReads += 1;
            return [];
          },
          createCommitSummary: async (input) => {
            summaryWrites += 1;
            return { id: 800 + input.projectId, ...input };
          },
          updateCommitSummary: async (summaryId, input) => ({
            id: summaryId,
            projectId: 31,
            summaryDate: "2026-07-24",
            ...input,
          }),
        },
        githubReader: {
          readRepository: async (repository) => ({
            repositoryId: Number(repository.repository.split("-").at(-1)),
            fullName: repository.fullName,
            canonicalUrl: repository.canonicalUrl,
            complete: true,
            lastActivityAt: "2026-07-24T01:00:00.000Z",
            commits: [commit(
              1,
              repository.fullName,
              `sha-${repository.repository}`,
              "2026-07-24T01:00:00.000Z",
            )],
          }),
        },
        summarizer: { summarize: async () => ({ summary: "当天总结", limitations: [] }) },
        store: createWritableStore(),
      }),
      ProjectProgressLeaseLostError,
    );

    assert.equal(statusWrites, 1);
    assert.equal(summaryReads, 0);
    assert.equal(summaryWrites, 0);
  });

  it("does not downgrade definitive lease loss from the trace channel", async () => {
    let projectReads = 0;

    await assert.rejects(
      syncProjectProgress({
        observedAt: new Date("2026-07-24T12:00:00.000Z"),
        trace: async () => {
          throw new AutomationLeaseLostError("expired", 409, "lease_expired");
        },
        oaClient: {
          listProjects: async () => {
            projectReads += 1;
            return [];
          },
          getProject: async () => {
            throw new Error("must not read");
          },
        },
        githubReader: {
          readRepository: async () => {
            throw new Error("must not read");
          },
        },
        summarizer: { summarize: async () => ({ summary: "unused", limitations: [] }) },
      }),
      AutomationLeaseLostError,
    );

    assert.equal(projectReads, 0);
  });
});

function createWritableStore() {
  let draft: Record<string, unknown> | null = null;
  return {
    saveProjectRepositoryWatermark: () => undefined,
    saveDailySummaryDraft: (value: Record<string, unknown>) => {
      draft = value;
    },
    getDailySummaryDraft: () => draft,
    enqueueOutbox: () => undefined,
    markOutboxApplied: () => undefined,
    markSummaryApplied: () => undefined,
    getManagedSummary: () => null,
  };
}

function commit(
  repositoryId: number,
  repositoryFullName: string,
  sha: string,
  committedAt: string,
) {
  return {
    repositoryId,
    repositoryFullName,
    sha,
    committedAt,
    subject: `commit ${sha}`,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
