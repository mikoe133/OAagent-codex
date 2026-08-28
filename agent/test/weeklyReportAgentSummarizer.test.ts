import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexWeeklyReportProjectSummaryAgent,
  type WeeklyReportAgentRunner,
} from "../src/application/weeklyReportAgentSummarizer.js";

const input = {
  report: {
    id: "report-1",
    weeklyNum: 202635,
    content: "项目平台：完成自动任务联调，并修复重复执行问题。",
    version: 3,
    updatedAt: "2026-08-27T09:30:00Z",
  },
  projects: [
    { id: 1, projectName: "平台", status: "updating" as const, aliases: ["自动化"] },
    { id: 2, projectName: "门户", status: "active" as const, aliases: [] },
  ],
};

test("asks the Agent to summarize weekly report content into allowlisted projects", async () => {
  let receivedPrompt = "";
  const runner: WeeklyReportAgentRunner = async (runInput) => {
    receivedPrompt = runInput.prompt;
    return {
      finalResponse: JSON.stringify({
        projects: [{
          project_id: 1,
          summary: "完成自动任务联调并修复重复执行问题。",
          confidence: 0.96,
          reason: "项目名称匹配",
        }, {
          project_id: 999,
          summary: "不应写入的项目",
          confidence: 1,
          reason: "模型猜测",
        }],
        unmatched: [],
        limitations: [],
      }),
      usage: null,
      upstreamRequestId: "weekly-thread-1",
      prohibitedToolUseCount: 0,
    };
  };

  const agent = new CodexWeeklyReportProjectSummaryAgent({
    model: {
      provider: "nexttoken",
      apiBaseUrl: "https://model.example.test/v1",
      apiKey: "secret",
      model: "gpt-5.6-terra",
      parameters: { reasoning_effort: "medium" },
    },
    workingDirectory: "/tmp",
  }, runner);

  const result = await agent.summarize(input);

  assert.match(receivedPrompt, /完成自动任务联调/);
  assert.match(receivedPrompt, /"id":1/);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]?.projectId, 1);
  assert.equal(result.projects[0]?.summary, "完成自动任务联调并修复重复执行问题。");
  assert.equal(result.interaction?.upstreamRequestId, "weekly-thread-1");
  assert.equal(result.interaction?.fallbackUsed, false);
});
