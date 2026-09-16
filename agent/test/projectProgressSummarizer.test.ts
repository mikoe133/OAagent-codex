import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeterministicProjectProgressSummarizer,
  isInvalidProjectProgressSummary,
  ResponsesProjectProgressSummarizer,
} from "../src/application/projectProgressSummarizer.js";

const input = {
  projectId: 12,
  projectName: "OA 平台",
  summaryDate: "2026-07-24",
  commits: [
    {
      repositoryId: 1,
      repositoryFullName: "example/api",
      sha: "abc",
      committedAt: "2026-07-24T01:00:00.000Z",
      activityAt: "2026-07-24T01:00:00.000Z",
      summaryDate: "2026-07-24",
      subject: "修复登录跳转",
      timestampAnomaly: false,
    },
  ],
};

describe("ResponsesProjectProgressSummarizer", () => {
  it("calls the isolated model and validates structured output", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
        parameters: {
          reasoning_effort: "high",
          max_output_tokens: 1_024,
        },
      },
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "完成登录跳转修复。",
                    limitations: [],
                  }),
                },
              ],
            },
          ],
        });
      },
    );

    assert.deepEqual(await summarizer.summarize(input), {
      summary: "完成登录跳转修复。",
      limitations: [],
    });
    assert.equal(requestBody?.model, "summary-model");
    assert.deepEqual(requestBody?.reasoning, { effort: "high" });
    assert.equal(requestBody?.max_output_tokens, 1_024);
    assert.doesNotMatch(JSON.stringify(requestBody), /secret/);
  });

  it("falls back deterministically when the model is unavailable", async () => {
    const fallback = new DeterministicProjectProgressSummarizer();
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
      },
      async () => new Response("unavailable", { status: 503 }),
      fallback,
    );

    const result = await summarizer.summarize(input);
    assert.match(result.summary, /修复登录跳转/);
    assert.deepEqual(result.limitations, ["模型总结失败，已使用确定性兜底"]);
  });

  it("builds a sanitized AI interaction for OA auditing", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
      },
      async () => Response.json({
        id: "response-01",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 20 },
        output: [{ content: [{
          type: "output_text",
          text: JSON.stringify({
            summary: "完成登录跳转修复。",
            limitations: ["仅依据 commit"],
          }),
        }] }],
      }),
    );

    const result = await summarizer.summarize(input);

    assert.equal(result.interaction?.provider, "nexttoken");
    assert.equal(result.interaction?.model, "gpt-5.6-terra");
    assert.deepEqual(result.interaction?.requestPayloadSanitized, {
      project_id: 12,
      summary_date: "2026-07-24",
      repository_count: 1,
      commit_count: 1,
      submitted_commit_count: 1,
    });
    assert.deepEqual(result.interaction?.responsePayloadSanitized, {
      status: "completed",
      output_count: 1,
    });
    assert.equal(result.interaction?.upstreamRequestId, "response-01");
    assert.equal(result.interaction?.inputTokens, 100);
    assert.equal(result.interaction?.outputTokens, 20);
    assert.doesNotMatch(JSON.stringify(result.interaction), /example\/api|abc|secret/);
  });

  it("sanitizes model output before it enters OA", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
      },
      async () => Response.json({ output: [{ content: [{
        type: "output_text",
        text: JSON.stringify({
          summary: "<b>完成修复</b> @all https://evil.example",
          limitations: ["<i>提交说明较短</i>"],
        }),
      }] }] }),
    );

    assert.deepEqual(await summarizer.summarize(input), {
      summary: "完成修复 all",
      limitations: ["提交说明较短"],
    });
  });

  it("uses the deterministic empty-subject fallback", async () => {
    const summarizer = new DeterministicProjectProgressSummarizer();
    const result = await summarizer.summarize({
      ...input,
      commits: [{ ...input.commits[0]!, subject: "" }],
    });
    assert.match(result.summary, /1 条代码提交/);
  });

  it("falls back when structured model output is malformed", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
      },
      async () => Response.json({ output: [{ content: [{
        type: "output_text",
        text: JSON.stringify({ summary: 123, limitations: "invalid" }),
      }] }] }),
    );

    assert.deepEqual((await summarizer.summarize(input)).limitations, [
      "模型总结失败，已使用确定性兜底",
    ]);
  });

  it("falls back when the model refuses to summarize available commits", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
      },
      async () => Response.json({ output: [{ content: [{
        type: "output_text",
        text: JSON.stringify({
          summary: "无可用候选提交，无法生成总结",
          limitations: [],
        }),
      }] }] }),
    );

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /修复登录跳转/);
    assert.deepEqual(result.limitations, ["模型总结失败，已使用确定性兜底"]);
  });

  it("falls back when the model returns punctuation instead of a summary", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer(
      {
        apiBaseUrl: "https://model.example.test/v1",
        apiKey: "secret",
        model: "summary-model",
      },
      async () => Response.json({ output: [{ content: [{
        type: "output_text",
        text: JSON.stringify({ summary: "...", limitations: [] }),
      }] }] }),
    );

    const result = await summarizer.summarize(input);

    assert.match(result.summary, /修复登录跳转/);
    assert.deepEqual(result.limitations, ["模型总结失败，已使用确定性兜底"]);
  });
});


describe("Chinese project progress output", () => {
  it("rejects English prose but accepts Chinese with technical names", () => {
    assert.equal(isInvalidProjectProgressSummary("Day 33 focused on documentation and tooling."), true);
    assert.equal(isInvalidProjectProgressSummary("完善 Agent API 文档并修复 GitHub OAuth 回调。"), false);
  });

  it("falls back on the Responses path when the model returns English", async () => {
    const summarizer = new ResponsesProjectProgressSummarizer({
      apiBaseUrl: "https://model.example.test/v1",
      apiKey: "secret",
      model: "summary-model",
    }, async () => Response.json({ output: [{ content: [{
      type: "output_text",
      text: JSON.stringify({ summary: "Fixed login redirects.", limitations: [] }),
    }] }] }));
    const result = await summarizer.summarize(input);
    assert.equal(result.summary, "完成修复登录跳转。");
    assert.deepEqual(result.limitations, ["模型总结失败，已使用确定性兜底"]);
  });

  it("uses a factual count instead of untranslated English subjects", async () => {
    const result = await new DeterministicProjectProgressSummarizer().summarize({
      ...input,
      commits: [{ ...input.commits[0]!, subject: "Fix login redirects" }],
    });
    assert.equal(result.summary, "完成 1 条代码提交。");
  });
});


describe("process narrative regression", () => {
  it("rejects first-person plans without rejecting completed engineering work", () => {
    for (const text of [
      "针对候选提交，我看到2个提交的标题都涉及中文验证和总结。让我先读取详细信息来了解这些提交的具体改动。",
      "让我先读取详细信息来了解这些提交的具体改动。",
      "我需要查看提交详情才能总结。",
      "请允许我读取文件详情。",
      "完成中文校验。让我先检查剩余提交。",
    ]) assert.equal(isInvalidProjectProgressSummary(text), true, text);
    for (const text of [
      "修复中文验证并合并至 test 和 main 分支。",
      "完成提交详情读取工具与候选提交分析功能。",
      "修复周报中过程描述的漏检问题。",
    ]) assert.equal(isInvalidProjectProgressSummary(text), false, text);
  });

  it("does not copy a process narrative from a commit into deterministic fallback", async () => {
    const result = await new DeterministicProjectProgressSummarizer().summarize({
      ...input, commits: [{ ...input.commits[0]!, subject: "让我先读取详细信息。" }],
    });
    assert.equal(result.summary, "完成 1 条代码提交。");
  });
});
