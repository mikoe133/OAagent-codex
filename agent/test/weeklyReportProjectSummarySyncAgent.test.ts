import assert from "node:assert/strict";
import test from "node:test";

import {
  syncWeeklyReportProjectSummaries,
  type WeeklyReportSummaryBindingStore,
} from "../src/application/weeklyReportProjectSummarySync.js";

test("writes Agent summaries separately to each matched project", async () => {
  const writes: Array<{ projectId: number; summary: string; aiConfidence: number }> = [];
  const client = {
    async listCommitSummaries() { return []; },
    async createCommitSummary(input: { projectId: number; summary: string; aiConfidence: number; summaryDate: string }) {
      writes.push(input);
      return { id: writes.length, ...input, aiNote: "" };
    },
  } as never;

  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-agent",
      weeklyNum: 202635,
      content: "项目 1：原始内容 A\n\n项目 2：原始内容 B",
      version: 4,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [
      { id: 1, projectName: "平台", status: "updating" },
      { id: 2, projectName: "门户", status: "active" },
    ],
    oaClient: client,
    summaryBindingStore: createSummaryBindingStore(),
    summarizer: {
      async summarize() {
        return {
          projects: [
            { projectId: 1, summary: "归纳后的平台进展", confidence: 0.95, reason: "模型匹配" },
            { projectId: 2, summary: "归纳后的门户进展", confidence: 0.88, reason: "模型匹配" },
          ],
          unmatched: [],
          limitations: [],
          interaction: {
            provider: "nexttoken",
            model: "gpt-5.6-terra",
            promptVersion: "weekly-report-agent-v1",
            systemPromptSnapshot: "test",
            requestPayloadSanitized: {},
            responsePayloadSanitized: {},
            finalSummary: "2 个项目归纳完成",
            limitations: [],
            fallbackUsed: false,
            upstreamRequestId: "weekly-thread-2",
            inputTokens: null,
            outputTokens: null,
            latencyMs: 1,
            status: "succeeded" as const,
            errorCode: null,
            errorSummary: null,
          },
        };
      },
    },
  });

  assert.deepEqual(writes.map(({ projectId, summary, aiConfidence }) => ({ projectId, summary, aiConfidence })), [
    { projectId: 1, summary: "归纳后的平台进展", aiConfidence: 95 },
    { projectId: 2, summary: "归纳后的门户进展", aiConfidence: 88 },
  ]);
  assert.equal(report.mutationsApplied, 2);
});

test("writes an Agent summary when the matched project is archived", async () => {
  const writes: number[] = [];
  let allowlistedStatuses: string[] = [];
  const client = {
    async listCommitSummaries() { return []; },
    async createCommitSummary(input: { projectId: number }) {
      writes.push(input.projectId);
      return { id: writes.length, ...input, summaryDate: "2026-08-30", summary: "", aiConfidence: 95, aiNote: "" };
    },
  } as never;

  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-agent-archived",
      weeklyNum: 202635,
      content: "项目 77：补充历史文档",
      version: 1,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [{ id: 77, projectName: "历史项目", status: "archived" }],
    includeArchivedProjects: false,
    writeArchivedProjects: false,
    oaClient: client,
    summaryBindingStore: createSummaryBindingStore(),
    summarizer: {
      async summarize(input) {
        allowlistedStatuses = input.projects.map((project) => project.status);
        const segment = input.segments[0]!;
        return {
          projects: [{
            projectId: 77,
            segmentKeys: [segment.segmentKey],
            summary: "补充历史文档",
            confidence: 0.95,
            reason: "模型匹配归档项目",
          }],
          unmatched: [],
          limitations: [],
        };
      },
    },
  });

  assert.deepEqual(allowlistedStatuses, ["archived"]);
  assert.deepEqual(writes, [77]);
  assert.equal(report.mutationsApplied, 1);
});

test("records weekly report stages and writes projects concurrently", async () => {
  let activeWrites = 0;
  let peakWrites = 0;
  const events: string[] = [];
  const client = {
    async listCommitSummaries() { return []; },
    async createCommitSummary(input: { projectId: number; summary: string; aiConfidence: number; summaryDate: string }) {
      activeWrites += 1;
      peakWrites = Math.max(peakWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeWrites -= 1;
      return { id: input.projectId, ...input, aiNote: "" };
    },
  } as never;
  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-trace",
      weeklyNum: 202635,
      content: "平台与门户本周均完成联调。",
      version: 1,
      updatedAt: "2026-08-27T09:30:00Z",
    },
    projects: [
      { id: 1, projectName: "平台", status: "active" },
      { id: 2, projectName: "门户", status: "active" },
    ],
    oaClient: client,
    summaryBindingStore: createSummaryBindingStore(),
    oaWriteConcurrency: 2,
    trace: async (event) => {
      events.push(`${event.phase}:${event.status}:${event.projectId ?? "all"}`);
    },
    summarizer: {
      async summarize() {
        return {
          projects: [
            { projectId: 1, summary: "平台联调完成", confidence: 0.95, reason: "模型匹配" },
            { projectId: 2, summary: "门户联调完成", confidence: 0.95, reason: "模型匹配" },
          ],
          unmatched: [],
          limitations: [],
        };
      },
    },
  });

  assert.equal(peakWrites, 2);
  assert.equal(report.metrics.oaWritePeakConcurrency, 2);
  assert.ok(events.includes("load_weekly_report:succeeded:all"));
  assert.ok(events.includes("load_projects:succeeded:all"));
  assert.ok(events.includes("weekly_report_agent:running:all"));
  assert.ok(events.includes("weekly_report_agent:succeeded:all"));
  assert.ok(events.includes("split_weekly_report:succeeded:all"));
  assert.ok(events.includes("write_project_summaries:running:all"));
  assert.ok(events.includes("write_project_summaries:succeeded:all"));
  assert.ok(events.includes("write_project_summary:running:1"));
  assert.ok(events.includes("write_project_summary:succeeded:1"));
  assert.ok(events.includes("write_project_summary:succeeded:2"));
});

test("preserves unmatched weekly report content as actionable pending items", async () => {
  const pendingBatches: unknown[] = [];
  const events: string[] = [];
  const report = await syncWeeklyReportProjectSummaries({
    report: {
      id: "report-pending",
      weeklyNum: 202635,
      content: "项目 51：完成自动任务联调\n\n项目 72：修复登录问题",
      version: 3,
      updatedAt: "2026-08-31T05:39:05.763Z",
    },
    projects: [{ id: 51, projectName: "Windows-ST", status: "updating" }],
    oaClient: {
      async listCommitSummaries() { return []; },
      async createCommitSummary(input: { projectId: number }) {
        return { id: 1, ...input, summaryDate: "2026-08-30", summary: "", aiConfidence: 100, aiNote: "" };
      },
    } as never,
    summaryBindingStore: createSummaryBindingStore(),
    pendingItemSink: async (items) => {
      pendingBatches.push(items);
    },
    trace: async (event) => {
      events.push(`${event.eventKey}:${event.status}:${event.message}`);
    },
    summarizer: {
      async summarize(input) {
        const pendingSegment = input.segments.find((segment) => segment.originalContent.includes("项目 72"))!;
        const matchedSegment = input.segments.find((segment) => segment.originalContent.includes("项目 51"))!;
        return {
          projects: [{
            projectId: 51,
            segmentKeys: [matchedSegment.segmentKey],
            summary: "完成自动任务联调",
            confidence: 0.99,
            reason: "项目 ID 精确匹配",
          }],
          unmatched: [{
            segmentKey: pendingSegment.segmentKey,
            summary: "修复登录问题",
            reasonCode: "project_not_found" as const,
            reason: "项目目录中不存在 ID 72",
            referencedProjectId: 72,
            candidateProjectIds: [],
            confidence: 0.99,
          }],
          limitations: [],
        };
      },
    },
  });

  assert.equal(report.pendingItems?.length, 1);
  assert.deepEqual(report.pendingItems?.[0], {
    segmentKey: report.pendingItems[0]?.segmentKey,
    segmentOrder: 2,
    contentDigest: report.pendingItems[0]?.contentDigest,
    originalContent: "项目 72：修复登录问题",
    aiSummary: "修复登录问题",
    aiReason: "项目目录中不存在 ID 72",
    reasonCode: "project_not_found",
    classificationSource: "agent",
    referencedProjectId: 72,
    candidateProjectIds: [],
    aiConfidence: 99,
  });
  assert.deepEqual(pendingBatches, [report.pendingItems]);
  assert.ok(events.some((event) => event.startsWith("weekly_report_pending_items:succeeded:已记录 1 条待处理内容")));
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
