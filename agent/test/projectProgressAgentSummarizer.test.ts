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
      subject: "fix login authorization flow",
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
  it("prefetches low-information commit details and retries an evidence-free summary", async () => {
    let runs = 0;
    let githubRequests = 0;
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      runs += 1;
      assert.match(runInput.prompt, /required_commit_details/);
      assert.match(runInput.prompt, /src\/auth\/session\.ts/);
      assert.match(runInput.prompt, /validateSession/);
      if (runs === 1) {
        return {
          finalResponse: JSON.stringify({
            summary: "更新了代码文件。",
            limitations: [],
          }),
          usage: null,
          upstreamRequestId: "thread-low-information-1",
          prohibitedToolUseCount: 0,
        };
      }
      assert.match(runInput.prompt, /quality_retry/);
      return {
        finalResponse: JSON.stringify({
          summary: "完善会话鉴权校验并补充无效令牌处理。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-low-information-2",
        prohibitedToolUseCount: 0,
      };
    };
    const lowInformationConfig = {
      ...config,
      githubFetchImpl: async () => {
        githubRequests += 1;
        return Response.json({
          stats: { additions: 12, deletions: 3, total: 15 },
          files: [{
            filename: "src/auth/session.ts",
            status: "modified",
            additions: 12,
            deletions: 3,
            changes: 15,
            patch: "@@ -1 +1 @@\n-export function validateSession() {}\n+export function validateSession(token: string) {}" +
              "x".repeat(1_200),
          }],
        });
      },
    };
    const summarizer = new CodexProjectProgressSummarizer(
      lowInformationConfig,
      runner,
    );

    const result = await summarizer.summarize({
      ...input,
      commits: input.commits.map((commit) => ({ ...commit, subject: "_" })),
    });

    assert.equal(runs, 2);
    assert.equal(githubRequests, 1);
    assert.equal(result.summary, "完善会话鉴权校验并补充无效令牌处理。");
    assert.equal(result.interaction?.responsePayloadSanitized.detail_calls, 1);
    assert.equal(result.interaction?.responsePayloadSanitized.github_detail_requests, 1);
    assert.equal(result.interaction?.responsePayloadSanitized.files_returned, 1);
    assert.ok(
      Number(result.interaction?.responsePayloadSanitized.patch_chars_returned) > 0,
    );
    assert.equal(result.interaction?.responsePayloadSanitized.quality_retries, 1);
    assert.equal(
      result.interaction?.responsePayloadSanitized.prefetched_detail_calls,
      1,
    );
    assert.deepEqual(result.limitations, [
      "Commit 详情已按文件或 Patch 预算裁剪",
    ]);
  });

  it("does not prefetch commit details for a descriptive subject", async () => {
    let githubRequests = 0;
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      assert.doesNotMatch(runInput.prompt, /required_commit_details/);
      return {
        finalResponse: JSON.stringify({
          summary: "修复登录鉴权流程。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-descriptive-subject",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer({
      ...config,
      githubFetchImpl: async () => {
        githubRequests += 1;
        return Response.json({});
      },
    }, runner);

    const result = await summarizer.summarize(input);

    assert.equal(githubRequests, 0);
    assert.equal(result.interaction?.responsePayloadSanitized.detail_calls, 0);
    assert.equal(result.interaction?.responsePayloadSanitized.quality_retries, 0);
    assert.equal(
      result.interaction?.responsePayloadSanitized.prefetched_detail_calls,
      0,
    );
  });

  it("records a failed mandatory detail lookup without claiming code evidence", async () => {
    let runs = 0;
    let cacheWrites = 0;
    const runner: ProjectProgressAgentRunner = async (runInput) => {
      runs += 1;
      assert.match(runInput.prompt, /required_commit_details/);
      assert.match(runInput.prompt, /GitHub 请求失败:HTTP 404/);
      assert.doesNotMatch(runInput.prompt, /quality_retry/);
      return {
        finalResponse: JSON.stringify({
          summary: "完成一条代码提交。",
          limitations: ["Commit 详情读取失败，无法判断具体改动"],
        }),
        usage: null,
        upstreamRequestId: "thread-detail-unavailable",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer({
      ...config,
      githubFetchImpl: async () => new Response("not found", { status: 404 }),
      repositorySummaryCache: {
        getRepositorySummaryCache: () => null,
        putRepositorySummaryCache: () => {
          cacheWrites += 1;
        },
      },
    }, runner);

    const result = await summarizer.summarize({
      ...input,
      commits: input.commits.map((commit) => ({ ...commit, subject: "_" })),
    });

    assert.equal(runs, 1);
    assert.equal(cacheWrites, 0);
    assert.equal(result.interaction?.responsePayloadSanitized.detail_calls, 1);
    assert.equal(result.interaction?.responsePayloadSanitized.github_detail_requests, 1);
    assert.equal(result.interaction?.responsePayloadSanitized.files_returned, 0);
    assert.equal(result.interaction?.responsePayloadSanitized.patch_chars_returned, 0);
    assert.equal(result.interaction?.responsePayloadSanitized.quality_retries, 0);
    assert.equal(
      result.interaction?.fallbackUsed,
      false,
      result.interaction?.errorSummary ?? "unexpected fallback",
    );
    assert.deepEqual(result.limitations, [
      "Commit 详情读取失败，无法判断具体改动",
      "低信息标题的 Commit 详情读取失败，无法核验具体代码改动",
    ]);
  });

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
    assert.equal(result.interaction?.promptVersion, "github-project-progress-agent-v6");
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

  it("reuses a successful repository summary cache across projects without another Agent run", async () => {
    const entries = new Map<string, { summary: string; limitations: string[] }>();
    const cache = {
      getRepositorySummaryCache: (identityDigest: string) =>
        entries.get(identityDigest) ?? null,
      putRepositorySummaryCache: (entry: {
        identityDigest: string;
        summary: string;
        limitations: string[];
      }) => {
        entries.set(entry.identityDigest, {
          summary: entry.summary,
          limitations: entry.limitations,
        });
      },
    };
    let runs = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      runs += 1;
      return {
        finalResponse: JSON.stringify({
          summary: "完成可复用的仓库语义总结。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-cache-source",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer({
      ...config,
      modelCatalogVersion: "catalog-v7",
      repositorySummaryCache: cache,
    }, runner);

    const first = await summarizer.summarize(input);
    const cached = await summarizer.summarize({
      ...input,
      projectId: 777,
      projectName: "另一个项目",
    });

    assert.equal(runs, 1);
    assert.equal(first.interaction?.responsePayloadSanitized.cache_hit, false);
    assert.equal(cached.summary, first.summary);
    assert.equal(cached.interaction?.responsePayloadSanitized.cache_hit, true);
    assert.equal(
      cached.interaction?.responsePayloadSanitized.execution_mode,
      "repository_summary_cache",
    );
    assert.equal(cached.interaction?.upstreamRequestId, null);
    assert.equal(cached.interaction?.inputTokens, null);
  });

  it("bypasses the repository cache for a manual regeneration", async () => {
    const entries = new Map<string, { summary: string; limitations: string[] }>();
    const cache = {
      getRepositorySummaryCache: (identityDigest: string) =>
        entries.get(identityDigest) ?? null,
      putRepositorySummaryCache: (entry: {
        identityDigest: string;
        summary: string;
        limitations: string[];
      }) => {
        entries.set(entry.identityDigest, {
          summary: entry.summary,
          limitations: entry.limitations,
        });
      },
    };
    let runs = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      runs += 1;
      return {
        finalResponse: JSON.stringify({
          summary: `完成第 ${runs} 次手动总结。`,
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: `thread-manual-${runs}`,
        prohibitedToolUseCount: 0,
      };
    };
    const first = new CodexProjectProgressSummarizer({
      ...config,
      repositorySummaryCache: cache,
    }, runner);
    const manual = new CodexProjectProgressSummarizer({
      ...config,
      repositorySummaryCache: cache,
      bypassRepositorySummaryCacheRead: true,
    }, runner);

    await first.summarize(input);
    const regenerated = await manual.summarize(input);

    assert.equal(runs, 2);
    assert.equal(regenerated.summary, "完成第 2 次手动总结。");
    assert.equal(regenerated.interaction?.responsePayloadSanitized.cache_hit, false);
  });

  it("invalidates repository cache entries when tool budgets change", async () => {
    const entries = new Map<string, { summary: string; limitations: string[] }>();
    const cache = {
      getRepositorySummaryCache: (identityDigest: string) =>
        entries.get(identityDigest) ?? null,
      putRepositorySummaryCache: (entry: {
        identityDigest: string;
        summary: string;
        limitations: string[];
      }) => {
        entries.set(entry.identityDigest, {
          summary: entry.summary,
          limitations: entry.limitations,
        });
      },
    };
    let runs = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      runs += 1;
      return {
        finalResponse: JSON.stringify({
          summary: `完成第 ${runs} 次仓库总结。`,
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: `thread-cache-${runs}`,
        prohibitedToolUseCount: 0,
      };
    };
    const first = new CodexProjectProgressSummarizer({
      ...config,
      modelCatalogVersion: "catalog-v7",
      repositorySummaryCache: cache,
    }, runner);
    const changedBudget = new CodexProjectProgressSummarizer({
      ...config,
      modelCatalogVersion: "catalog-v7",
      repositorySummaryCache: cache,
      agent: { ...config.agent, maxDetailCalls: config.agent.maxDetailCalls + 1 },
    }, runner);

    await first.summarize(input);
    await changedBudget.summarize(input);

    assert.equal(runs, 2);
    assert.equal(entries.size, 2);
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

    assert.match(result.summary, /fix login authorization flow/);
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

    assert.match(result.summary, /fix login authorization flow/);
    assert.deepEqual(result.limitations, ["Agent 总结失败，已使用确定性兜底"]);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.match(result.interaction?.errorSummary ?? "", /最终项目总结/);
  });

  it("falls back when a later sentence describes the Agent's next step", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({
        summary: "候选人提交包含两项非合并提交：新建任务后端服务及修复幂等自动化领取请求。我将查看两者的详情以总结进展。",
        limitations: [],
      }),
      usage: null,
      upstreamRequestId: "thread-late-process-summary",
      prohibitedToolUseCount: 0,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /fix login authorization flow/);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.match(result.interaction?.errorSummary ?? "", /最终项目总结/);
  });

  it("falls back when Agent refuses to summarize available commits", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({
        summary: "无可用候选提交，无法生成总结",
        limitations: [],
      }),
      usage: null,
      upstreamRequestId: "thread-refusal-summary",
      prohibitedToolUseCount: 0,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /fix login authorization flow/);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.match(result.interaction?.errorSummary ?? "", /最终项目总结/);
  });

  it("falls back when Agent returns punctuation instead of a summary", async () => {
    const runner: ProjectProgressAgentRunner = async () => ({
      finalResponse: JSON.stringify({ summary: "...", limitations: [] }),
      usage: null,
      upstreamRequestId: "thread-punctuation-summary",
      prohibitedToolUseCount: 0,
    });
    const summarizer = new CodexProjectProgressSummarizer(config, runner);

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /fix login authorization flow/);
    assert.equal(result.interaction?.fallbackUsed, true);
    assert.equal(result.interaction?.status, "fallback");
    assert.equal(result.interaction?.errorCode, "agent_summary_failed");
  });

  it("ignores a cached process step and replaces it with a final summary", async () => {
    const entries = new Map<string, { summary: string; limitations: string[] }>();
    const cache = {
      getRepositorySummaryCache: (identityDigest: string) =>
        entries.get(identityDigest) ?? null,
      putRepositorySummaryCache: (entry: {
        identityDigest: string;
        summary: string;
        limitations: string[];
      }) => {
        entries.set(entry.identityDigest, {
          summary: entry.summary,
          limitations: entry.limitations,
        });
      },
    };
    let runs = 0;
    const runner: ProjectProgressAgentRunner = async () => {
      runs += 1;
      return {
        finalResponse: JSON.stringify({
          summary: "完成任务后端服务并修复自动化领取幂等性。",
          limitations: [],
        }),
        usage: null,
        upstreamRequestId: "thread-cache-repair",
        prohibitedToolUseCount: 0,
      };
    };
    const summarizer = new CodexProjectProgressSummarizer({
      ...config,
      repositorySummaryCache: cache,
    }, runner);

    await summarizer.summarize(input);
    const identityDigest = entries.keys().next().value as string;
    entries.set(identityDigest, {
      summary: "候选提交已找到。我将查看详情以总结进展。",
      limitations: [],
    });
    const repaired = await summarizer.summarize(input);

    assert.equal(runs, 2);
    assert.equal(repaired.summary, "完成任务后端服务并修复自动化领取幂等性。");
    assert.equal(repaired.interaction?.responsePayloadSanitized.cache_hit, false);
    assert.equal(entries.get(identityDigest)?.summary, repaired.summary);
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
