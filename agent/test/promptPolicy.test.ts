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
    assert.match(prompts, /不输出 API 调用依据/);
    assert.doesNotMatch(prompts, /最终回答必须包含关键接口依据/);
    assert.doesNotMatch(prompts, /先给结论,再给接口依据/);
  });

  it("uses compact candidates instead of broad OpenAPI scans", async () => {
    const prompts = `${await readPrompt("system.md")}\n${await readPrompt("document-policy.md")}`;

    assert.match(prompts, /候选接口索引/);
    assert.match(prompts, /最多读取一次选定 operation 的完整 schema/);
    assert.doesNotMatch(prompts, /必须先通过 shell 管道使用 `grep`/);
  });
});

function readPrompt(fileName: string): Promise<string> {
  return readFile(new URL(fileName, promptsDirectory), "utf8");
}
