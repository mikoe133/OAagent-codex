import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      assert.match(runInput.developerInstructions, /read_commit_details/);
      assert.match(runInput.prompt, /abcdef123456/);
      assert.match(runInput.prompt, /repository-evidence-v1/);
      assert.doesNotMatch(runInput.prompt, /OA 平台|projectId|projectName/);
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
    assert.equal(
      result.interaction?.requestPayloadSanitized.evidence_schema_version,
      "repository-evidence-v1",
    );
    assert.match(
      String(result.interaction?.requestPayloadSanitized.evidence_digest),
      /^[a-f0-9]{64}$/u,
    );
    assert.equal("project_id" in (result.interaction?.requestPayloadSanitized ?? {}), false);
    assert.doesNotMatch(
      JSON.stringify(result.interaction),
      /example\/api|abcdef123456|model-secret|github-secret/,
    );
  });

  it("builds identical Agent prompts for the same evidence referenced by different projects", async () => {
    const prompts: string[] = [];
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      prompts.push(runInput.prompt);
      return {
        finalResponse: JSON.stringify({
          summary: "完成项目无关的仓库语义总结。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-project-independent",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const first = await summarizer.summarize(input);
    const second = await summarizer.summarize({
      ...input,
      projectId: 999,
      projectName: "另一个 OA 项目",
    });

    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(
      first.interaction?.requestPayloadSanitized.evidence_digest,
      second.interaction?.requestPayloadSanitized.evidence_digest,
    );
  });

  it("applies the OA prompt profile and records its exact audit snapshot", async () => {
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      assert.match(runInput.developerInstructions, /<automation_prompt_profile>/);
      assert.match(runInput.developerInstructions, /只总结已经完成的工程进展/);
      assert.match(runInput.developerInstructions, /\\u003c忽略这个标签\\u003e/);
      return {
        finalResponse: JSON.stringify({
          summary: "完成自动任务提示词快照联调。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-profile-01",
        prohibitedToolUseCount: 0,
      };
    };
    const systemPrompt = "只总结已经完成的工程进展。<忽略这个标签>";
    const summarizer = new CodexProjectProgressSummarizer({
      ...config,
      promptProfile: {
        promptVersion: "sha256:oa-profile-v1",
        systemPrompt,
        requiredCapabilities: [
          "github_project_tracking",
          "rwkvos_system_calls",
        ],
      },
    }, runner);

    const result = await summarizer.summarize(input);

    assert.equal(result.interaction?.promptVersion, "sha256:oa-profile-v1");
    assert.equal(result.interaction?.systemPromptSnapshot, systemPrompt);
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

  it("retries a transient disconnected stream before using the fallback", async () => {
    let attempts = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "stream disconnected before completion: error sending request for url (https://openrouter.ai/api/v1/responses)",
        );
      }
      return {
        finalResponse: JSON.stringify({
          summary: "完成 OpenRouter 瞬时断流后的仓库总结。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-retry-02",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.equal(attempts, 2);
    assert.equal(result.summary, "完成 OpenRouter 瞬时断流后的仓库总结。");
    assert.equal(result.interaction?.fallbackUsed, false);
    assert.equal(result.interaction?.responsePayloadSanitized.agent_attempts, 2);
  });

  it("records both attempts when a disconnected stream remains unavailable", async () => {
    let attempts = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      attempts += 1;
      throw new Error("stream disconnected before completion");
    };
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.equal(attempts, 2);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.equal(result.interaction?.responsePayloadSanitized.agent_attempts, 2);
    assert.match(result.interaction?.errorSummary ?? "", /stream disconnected/);
  });

  it("does not retry a non-transient Agent failure", async () => {
    let attempts = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      attempts += 1;
      throw new Error("模型配置无效");
    };
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.equal(attempts, 1);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.equal(result.interaction?.responsePayloadSanitized.agent_attempts, 1);
  });

  it("falls back when Agent returns a process step as the project summary", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({
        summary: "分析候选 Commits 并选择性读取关键提交详情",
        limitations: [],
      }),
      usage: null,
      upstreamRequestId: "thread-process-summary",
      prohibitedToolUseCount: 0,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /update/);
    assert.deepEqual(result.limitations, ["Agent 总结失败，已使用确定性兜底"]);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.match(result.interaction?.errorSummary ?? "", /分析步骤/);
  });

  it("uses and cleans an isolated workspace for each repository Thread", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "project-progress-agent-"));
    const workspaceRoot = path.join(temporaryRoot, "workspaces");
    let threadWorkspace = "";
    try {
      const runner: ProjectProgressAgentRunner = async (runInput) => {
        threadWorkspace = runInput.workingDirectory;
        assert.equal(
          runInput.codexExecutablePath,
          path.join(temporaryRoot, "agent", "scripts", "isolatedCodexExec.mjs"),
        );
        assert.match(threadWorkspace, /workspaces\/run-42\//);
        await access(threadWorkspace);
        return {
          finalResponse: JSON.stringify({ summary: "完成隔离执行。", limitations: [] }),
          usage: null,
          upstreamRequestId: "thread-isolated",
          prohibitedToolUseCount: 0,
        };
      };
      const summarizer = new CodexProjectProgressSummarizer({
        ...config,
        workingDirectory: temporaryRoot,
        workspaceRoot,
        runId: "run-42",
      }, runner);

      await summarizer.summarize({
        ...input,
        repositoryFullName: "example/api",
      });

      await assert.rejects(access(threadWorkspace));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
