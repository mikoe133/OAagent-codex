import assert from "node:assert/strict";
import test from "node:test";

import { syncWeeklyReportProjectSummaries } from "../src/application/weeklyReportProjectSummarySync.js";

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
