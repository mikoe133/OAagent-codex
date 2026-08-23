import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const promptsDirectory = new URL("../prompts/", import.meta.url);

describe("OA agent prompt policy", () => {
  it("prioritizes ordinary-user endpoints and stops permission retries", async () => {
    const systemPrompt = await readPrompt("system.md");

    assert.match(systemPrompt, /查询任务遵循最小权限原则/);
    assert.match(systemPrompt, /必须优先于 `\/admin\/\*`/);
    assert.match(systemPrompt, /遇到 401、403/);
    assert.match(systemPrompt, /相同 operationId 和相同参数的请求不得重复调用/);
  });

  it("keeps API and tool details out of final answers", async () => {
    const prompts = `${await readPrompt("system.md")}\n${await readPrompt("output-policy.md")}`;

    assert.match(prompts, /最终回答只展示用户需要的业务结果/);
    assert.match(prompts, /多个子问题.*逐项/);
    assert.match(prompts, /最后一次工具调用之后/);
    assert.match(prompts, /不输出 API 调用依据/);
    assert.doesNotMatch(prompts, /最终回答必须包含关键接口依据/);
    assert.doesNotMatch(prompts, /先给结论,再给接口依据/);
  });

  it("uses compact candidates before a bounded fallback OpenAPI scan", async () => {
    const prompts = `${await readPrompt("system.md")}\n${await readPrompt("document-policy.md")}`;

    assert.match(prompts, /候选接口索引/);
    assert.match(prompts, /高置信度单步查询最多读取一次选定 operation/);
    assert.match(prompts, /复杂或不确定查询可按需读取多个相关 operation/);
    assert.match(prompts, /候选接口.*未包含.*用户意图/);
    assert.match(prompts, /候选以外的完整 OpenAPI/);
    assert.match(prompts, /不得因候选接口未命中就直接断言接口不存在/);
    assert.doesNotMatch(prompts, /必须先通过 shell 管道使用 `grep`/);
  });

  it("recovers autonomously from item-level failures in confirmed batch updates", async () => {
    const systemPrompt = await readPrompt("system.md");

    assert.match(systemPrompt, /批量写操作.*按记录独立处理/);
    assert.match(systemPrompt, /单条.*失败.*继续.*其余/);
    assert.match(systemPrompt, /历史.*归档.*不是.*不可更新/);
    assert.match(systemPrompt, /项目列表.*重新发现.*项目 ID/);
    assert.match(systemPrompt, /GitHub.*github_urls/);
    assert.match(systemPrompt, /写入后.*回查.*不属于.*重复调用/);
  });

  it("separates structured OA data from knowledge document content", async () => {
    const prompts = `${await readPrompt("system.md")}\n${await readPrompt("document-policy.md")}`;

    assert.match(prompts, /结构化 OA 数据/);
    assert.match(prompts, /知识库.*文档内容/);
    assert.match(prompts, /knowledge_base_read/);
    assert.match(prompts, /knowledge_base_write/);
    assert.match(prompts, /知识库写操作.*用户确认/);
    assert.match(prompts, /不得.*改用.*OA 接口/);
  });

  it("requires independent knowledge intents and bounded query fan-out", async () => {
    const prompts = `${await readPrompt("system.md")}\n${await readPrompt(
      "document-policy.md",
    )}`;

    assert.match(prompts, /多个知识库子问题.*分别/);
    assert.match(prompts, /不得.*无关.*合并.*q/);
    assert.match(prompts, /一个核心词.*一次/);
    assert.match(prompts, /两个核心词.*完整短语和主实体/);
    assert.match(prompts, /总上限.*3.*次/);
    assert.match(prompts, /不得.*自行发明.*同义词/);
  });
});

function readPrompt(fileName: string): Promise<string> {
  return readFile(new URL(fileName, promptsDirectory), "utf8");
}
