import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncProjectProgress } from "../src/application/syncProjectProgress.js";
import type { GitHubRepositorySnapshot } from "../src/infrastructure/github/githubTypes.js";

describe("syncProjectProgress", () => {
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
    assert.equal(report?.summaries[0]?.summary, "共 2 条提交");
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
    await syncProjectProgress(dependencies);

    assert.equal(summaries, 1);
  });

  it("applies status and summary writes only in explicit single-project test mode", async () => {
    const mutations: string[] = [];
    const project = {
      id: 12,
      projectName: "write-test",
      status: "maintenance" as const,
      githubUrls: ["https://github.com/alpha/api"],
    };
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      projectId: 12,
      writeMode: "unsafe-test",
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
          return detailReads === 1 ? project : { ...project, status: "archived" as const };
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
    const projects = [21, 22].map((id) => ({
      id,
      projectName: `project-${id}`,
      status: "updating" as const,
      githubUrls: [`https://github.com/alpha/project-${id}`],
    }));
    const result = await syncProjectProgress({
      observedAt: new Date("2026-07-24T12:00:00.000Z"),
      writeMode: "production",
      oaClient: {
        listProjects: async () => projects,
        getProject: async (projectId) => projects.find((project) => project.id === projectId)!,
        updateProjectStatus: async () => undefined,
        listCommitSummaries: async () => [],
        createCommitSummary: async (input) => {
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

  it("recommends a scheduler retry after a transient project failure", async () => {
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

    assert.equal(result.retryRecommended, true);
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
