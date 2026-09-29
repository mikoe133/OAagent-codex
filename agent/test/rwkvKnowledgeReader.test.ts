import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildRwkvRuntimeGuidance,
  RWKV_KNOWLEDGE_SOURCES,
} from "../src/infrastructure/routing/rwkvKnowledgeModule.js";

test("RWKV reader extracts evidence, caches pages, and bounds error recovery", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./rwkvKnowledgeReader_test.py", import.meta.url))], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("RWKV runtime uses the shared source catalog and unified reader", () => {
  const guidance = buildRwkvRuntimeGuidance(["rwkv_knowledge"]);
  assert.ok(guidance);
  assert.match(guidance, /python3 scripts\/readRwkvKnowledge\.py/);
  assert.match(guidance, /概述.*先读取 rwkv-overview/);
  assert.match(guidance, /已有证据足以回答时立即停止/);
  assert.match(guidance, /不得关闭证书验证/);
  assert.doesNotMatch(guidance, /可通过 curl/);
  assert.equal(new Set(RWKV_KNOWLEDGE_SOURCES.map(source => source.id)).size, RWKV_KNOWLEDGE_SOURCES.length);
  for (const source of RWKV_KNOWLEDGE_SOURCES) {
    assert.ok(source.fetchUrl.startsWith("https://"));
    assert.ok(guidance.includes(`[${source.id}]`));
  }
});
