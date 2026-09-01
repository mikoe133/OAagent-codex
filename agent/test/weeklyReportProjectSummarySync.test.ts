import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  splitWeeklyReportContent,
  syncWeeklyReportProjectSummaries,
  weeklyReportSummaryDate,
  type WeeklyReportSummaryBindingStore,
} from "../src/application/weeklyReportProjectSummarySync.js";

test("splits project sections by stable id and exact name, including archived projects", () => {
  const result = splitWeeklyReportContent(
    "项目 51：完成自动任务联调\n\nProject Archive：补充历史文档\n\n未归属内容",
    [
      { id: 51, projectName: "平台自动化", status: "updating", aliases: ["自动任务"] },
      { id: 77, projectName: "Project Archive", status: "archived", aliases: ["历史项目"] },
    ],
  );

  assert.deepEqual(result.matches, [
    { projectId: 51, content: "项目 51：完成自动任务联调", confidence: 1, reason: "project_id" },
    { projectId: 77, content: "Project Archive：补充历史文档", confidence: 1, reason: "exact_name" },
  ]);
  assert.deepEqual(result.unmatched, ["未归属内容"]);
});

test("does not write ambiguous project names", () => {
  const result = splitWeeklyReportContent(
    "平台：完成接口联调",
    [
      { id: 1, projectName: "平台", status: "active" },
      { id: 2, projectName: "平台", status: "archived" },
    ],
  );

  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.unmatched, ["平台：完成接口联调"]);
  assert.equal(result.ambiguous.length, 1);
});

test("maps ISO weekly number to a stable Sunday summary date", () => {
  assert.equal(weeklyReportSummaryDate(202635), "2026-08-30");
  assert.equal(weeklyReportSummaryDate(202053), "2021-01-03");
  assert.throws(() => weeklyReportSummaryDate(202153), /weekly_num 不存在/);
});

test("always writes matching archived projects through the daily summary API", async () => {
  const writes: Array<{ projectId: number; summaryDate: string }> = [];
  const client = {
    async listCommitSummaries() { return []; },
    async createCommitSummary(input: { projectId: number; summaryDate: string }) {
      writes.push(input);
      return { id: writes.length, ...input, summary: "", aiConfidence: 100, aiNote: "" };
    },
  } as never;
  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-1",
      weeklyNum: 202635,
      content: "项目 1：本周完成联调\n\n项目 2：补充归档文档",
      version: 3,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [
      { id: 1, projectName: "平台", status: "updating" },
      { id: 2, projectName: "归档项目", status: "archived" },
    ],
    oaClient: client,
    includeArchivedProjects: false,
    writeArchivedProjects: false,
    summaryBindingStore: createSummaryBindingStore(),
  });
  assert.deepEqual(writes.map(({ projectId, summaryDate }) => ({ projectId, summaryDate })), [
    { projectId: 1, summaryDate: "2026-08-30" },
    { projectId: 2, summaryDate: "2026-08-30" },
  ]);
  assert.equal(report.mutationsApplied, 2);
});

test("creates an independent summary when another source already has the same project date", async () => {
  const created: number[] = [];
  const updated: number[] = [];
  const bindings = new Map<string, { commitSummaryId: number; sourceVersion: number }>();
  await syncWeeklyReportProjectSummaries({
    report: {
      id: "weekly-report-1",
      weeklyNum: 202635,
      content: "项目 51：完成周报联调",
      version: 1,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [{ id: 51, projectName: "平台", status: "updating" }],
    oaClient: {
      async listCommitSummaries() {
        return [{
          id: 900,
          projectId: 51,
          summaryDate: "2026-08-30",
          summary: "GitHub Commit 总结",
          aiConfidence: 100,
          aiNote: "GitHub 自动任务",
        }];
      },
      async createCommitSummary(input: { projectId: number }) {
        created.push(input.projectId);
        return {
          id: 901,
          ...input,
          summaryDate: "2026-08-30",
          summary: "完成周报联调",
          aiConfidence: 100,
          aiNote: "周报",
        };
      },
      async updateCommitSummary(summaryId: number) {
        updated.push(summaryId);
        throw new Error("must not update another source");
      },
    } as never,
    summaryBindingStore: {
      async findBinding(input) {
        return bindings.get(`${input.sourceReportId}:${input.projectId}:${input.summaryDate}`) ?? null;
      },
      async saveBinding(input) {
        const binding = {
          commitSummaryId: input.commitSummaryId,
          sourceVersion: input.sourceVersion,
        };
        bindings.set(
          `${input.sourceReportId}:${input.projectId}:${input.summaryDate}`,
          binding,
        );
        return binding;
      },
    },
  } as never);

  assert.deepEqual(created, [51]);
  assert.deepEqual(updated, []);
  assert.deepEqual(bindings.get("weekly-report-1:51:2026-08-30"), {
    commitSummaryId: 901,
    sourceVersion: 1,
  });
});

test("updates only the summary bound to the same weekly report", async () => {
  const updated: number[] = [];
  const bindings = new Map([
    ["weekly-report-1:51:2026-08-30", { commitSummaryId: 901, sourceVersion: 1 }],
  ]);
  await syncWeeklyReportProjectSummaries({
    report: {
      id: "weekly-report-1",
      weeklyNum: 202635,
      content: "项目 51：完成周报联调第二版",
      version: 2,
      updatedAt: "2026-08-28T09:30:00Z",
    },
    projects: [{ id: 51, projectName: "平台", status: "updating" }],
    oaClient: {
      async listCommitSummaries() {
        throw new Error("must not scan summaries by project and date");
      },
      async getCommitSummary(summaryId: number) {
        return {
          id: summaryId,
          projectId: 51,
          summaryDate: "2026-08-30",
          summary: "完成周报联调第一版",
          aiConfidence: 100,
          aiNote: "旧周报",
          version: 3,
        };
      },
      async createCommitSummary() {
        throw new Error("must not create a duplicate weekly summary");
      },
      async updateCommitSummary(summaryId: number, input: unknown) {
        updated.push(summaryId);
        return {
          id: summaryId,
          projectId: 51,
          summaryDate: "2026-08-30",
          summary: "完成周报联调第二版",
          aiConfidence: 100,
          aiNote: "新周报",
          version: 4,
          input,
        };
      },
    } as never,
    summaryBindingStore: {
      async findBinding(input) {
        return bindings.get(`${input.sourceReportId}:${input.projectId}:${input.summaryDate}`) ?? null;
      },
      async saveBinding(input) {
        const binding = {
          commitSummaryId: input.commitSummaryId,
          sourceVersion: input.sourceVersion,
        };
        bindings.set(
          `${input.sourceReportId}:${input.projectId}:${input.summaryDate}`,
          binding,
        );
        return binding;
      },
    },
  } as never);

  assert.deepEqual(updated, [901]);
  assert.deepEqual(bindings.get("weekly-report-1:51:2026-08-30"), {
    commitSummaryId: 901,
    sourceVersion: 2,
  });
});

test("reuses the bound summary without another mutation when a Worker retries", async () => {
  const content = "项目 51：完成周报联调";
  const sourceReportId = "weekly-report-retry";
  const sourceMarker = createHash("sha256")
    .update(sourceReportId, "utf8")
    .digest("hex");
  const binding = { commitSummaryId: 902, sourceVersion: 1 };
  let savedVersion = 0;
  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: sourceReportId,
      weeklyNum: 202635,
      content,
      version: 1,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [{ id: 51, projectName: "平台", status: "updating" }],
    oaClient: {
      async listCommitSummaries() {
        throw new Error("must not scan summaries for a bound source");
      },
      async getCommitSummary() {
        return {
          id: 902,
          projectId: 51,
          summaryDate: "2026-08-30",
          summary: content,
          aiConfidence: 100,
          aiNote: `[OAAGENT_WEEKLY_REPORT_SOURCE:${sourceMarker}]\n202635 周报（2026-08-27T09:30:00Z）：${content}\n项目拆分片段：${content}`,
          version: 1,
        };
      },
      async createCommitSummary() {
        throw new Error("must not create on retry");
      },
      async updateCommitSummary() {
        throw new Error("must not update unchanged content on retry");
      },
    } as never,
    summaryBindingStore: {
      async findBinding() {
        return binding;
      },
      async saveBinding(input) {
        savedVersion = input.sourceVersion;
        return {
          commitSummaryId: input.commitSummaryId,
          sourceVersion: input.sourceVersion,
        };
      },
    },
  });

  assert.equal(report.mutationsApplied, 0);
  assert.equal(savedVersion, 1);
});

test("records an explicitly referenced missing project without an Agent", async () => {
  const batches: unknown[] = [];
  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-missing-project",
      weeklyNum: 202635,
      content: "项目 72：修复登录问题",
      version: 1,
      updatedAt: "2026-08-31T03:53:30.107Z",
    },
    projects: [{ id: 51, projectName: "平台", status: "active" }],
    oaClient: {
      async listCommitSummaries() { return []; },
      async createCommitSummary() { throw new Error("should not write"); },
    } as never,
    summaryBindingStore: createSummaryBindingStore(),
    pendingItemSink: async (items) => {
      batches.push(items);
    },
  });

  assert.equal(report.projects.length, 0);
  assert.deepEqual(report.pendingItems?.map((item) => ({
    originalContent: item.originalContent,
    aiSummary: item.aiSummary,
    reasonCode: item.reasonCode,
    referencedProjectId: item.referencedProjectId,
  })), [{
    originalContent: "项目 72：修复登录问题",
    aiSummary: "修复登录问题",
    reasonCode: "project_not_found",
    referencedProjectId: 72,
  }]);
  assert.deepEqual(batches, [report.pendingItems]);
});

function createSummaryBindingStore(): WeeklyReportSummaryBindingStore {
  const bindings = new Map<string, { commitSummaryId: number; sourceVersion: number }>();
  return {
    async findBinding(input) {
      return bindings.get(
        `${input.sourceReportId}:${input.projectId}:${input.summaryDate}`,
      ) ?? null;
    },
    async saveBinding(input) {
      const binding = {
        commitSummaryId: input.commitSummaryId,
        sourceVersion: input.sourceVersion,
      };
      bindings.set(
        `${input.sourceReportId}:${input.projectId}:${input.summaryDate}`,
        binding,
      );
      return binding;
    },
  };
}
