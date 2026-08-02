import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexProjectProgressSummarizer,
  type ProjectProgressAgentRunner,
} from "../src/application/projectProgressAgentSummarizer.js";

const input = {
  projectId: 12,
  projectName: "OA 平台",
  summaryDate: "2026-07-31",
  commits: [
    {
      repositoryId: 1,
      repositoryFullName: "example/api",
      sha: "abcdef123456",
      committedAt: "2026-07-31T01:00:00.000Z",
      activityAt: "2026-07-31T01:00:00.000Z",
      summaryDate: "2026-07-31",
      subject: "update",
      timestampAnomaly: false,
    },
  ],
};

const config = {
  model: {
    provider: "nexttoken" as const,
    apiBaseUrl: "https://model.example.test/v1",
    apiKey: "model-secret",
    model: "gpt-5.6-terra",
    parameters: { reasoning_effort: "medium" as const },
  },
  githubToken: "github-secret",
  githubApiBaseUrl: "https://api.github.test",
  agent: {
    maxCandidateCommits: 50,
    maxDetailCalls: 12,
    maxFilesPerCommit: 20,
    maxFilenameChars: 240,
    maxPatchCharsPerFile: 1_200,
    maxTotalPatchChars: 12_000,
  },
  workingDirectory: "/tmp",
};

describe("CodexProjectProgressSummarizer", () => {
  it("uses structured Agent output and records sanitized SDK audit data", async () => {
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      assert.match(runInput.prompt, /read_commit_details/);
      assert.match(runInput.prompt, /abcdef123456/);
      assert.doesNotMatch(runInput.prompt, /model-secret|github-secret/);
      return {
        finalResponse: JSON.stringify({
          summary: "完成登录链路与权限校验更新。",
          limitations: [],
        }),
        usage: {
          input_tokens: 120,
          cached_input_tokens: 10,
          output_tokens: 30,
          reasoning_output_tokens: 20,
        },
        upstreamRequestId: "thread-01",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.equal(result.summary, "完成登录链路与权限校验更新。");
    assert.equal(result.interaction?.promptVersion, "github-project-progress-agent-v2");
    assert.equal(result.interaction?.inputTokens, 120);
    assert.equal(result.interaction?.outputTokens, 30);
    assert.equal(result.interaction?.responsePayloadSanitized.execution_mode, "codex_sdk_agent");
    assert.equal(result.interaction?.responsePayloadSanitized.detail_calls, 0);
    assert.doesNotMatch(
      JSON.stringify(result.interaction),
      /example\/api|abcdef123456|model-secret|github-secret/,
    );
  });

  it("rejects output from a run that used an unauthorized tool", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({ summary: "不应采纳", limitations: [] }),
      usage: null,
      upstreamRequestId: null,
      prohibitedToolUseCount: 1,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /update/);
    assert.deepEqual(result.limitations, ["Agent 总结失败，已使用确定性兜底"]);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.equal(result.interaction?.errorCode, "agent_summary_failed");
    assert.equal(result.interaction?.responsePayloadSanitized.prohibited_tool_use_count, 1);
  });

  it("falls back when Agent structured output is malformed", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({ summary: 123 }),
      usage: null,
      upstreamRequestId: null,
      prohibitedToolUseCount: 0,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.equal(result.interaction?.status, "fallback");
    assert.match(result.interaction?.errorSummary ?? "", /结构化输出/);
  });
});
