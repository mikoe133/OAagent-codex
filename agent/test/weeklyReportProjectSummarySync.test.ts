import assert from "node:assert/strict";
import test from "node:test";

import {
  splitWeeklyReportContent,
  syncWeeklyReportProjectSummaries,
  weeklyReportSummaryDate,
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

test("writes matching active and archived projects through the daily summary API", async () => {
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
  });
  assert.deepEqual(writes.map(({ projectId, summaryDate }) => ({ projectId, summaryDate })), [
    { projectId: 1, summaryDate: "2026-08-30" },
    { projectId: 2, summaryDate: "2026-08-30" },
  ]);
  assert.equal(report.mutationsApplied, 2);
});
