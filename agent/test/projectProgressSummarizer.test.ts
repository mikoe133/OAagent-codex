import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeterministicProjectProgressSummarizer,
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
});
