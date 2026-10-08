import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { resolveCodexModelCatalogPath } from "../src/infrastructure/codex/modelMetadataCatalog.js";

test("loads custom Codex metadata for answer and lightweight router models", () => {
  const glmCatalogPath = resolveCodexModelCatalogPath("z-ai/glm-5.3");
  const terraCatalogPath = resolveCodexModelCatalogPath("gpt-5.6-terra");
  const kimiCatalogPath = resolveCodexModelCatalogPath("moonshotai/kimi-k3");
  const deepSeekFlashCatalogPath = resolveCodexModelCatalogPath(
    "deepseek/deepseek-v4.1-flash",
  );
  const glmRouterCatalogPath = resolveCodexModelCatalogPath(
    "z-ai/glm-4.7-flash",
  );
  const qwenRouterCatalogPath = resolveCodexModelCatalogPath(
    "qwen/qwen3.5-flash-02-23",
  );
  const deepSeekRouterCatalogPath = resolveCodexModelCatalogPath(
    "deepseek/deepseek-v4-flash",
  );

  assert.equal(resolveCodexModelCatalogPath("qwen/qwen3.8-max-0902"), glmCatalogPath);
  assert.ok(glmCatalogPath);
  assert.equal(terraCatalogPath, glmCatalogPath);
  assert.ok(terraCatalogPath);
  assert.equal(kimiCatalogPath, terraCatalogPath);
  assert.equal(resolveCodexModelCatalogPath("deepseek/deepseek-v4-pro"), undefined);
  assert.equal(deepSeekFlashCatalogPath, glmCatalogPath);
  assert.equal(glmRouterCatalogPath, glmCatalogPath);
  assert.equal(qwenRouterCatalogPath, glmCatalogPath);
  assert.equal(deepSeekRouterCatalogPath, glmCatalogPath);
  assert.equal(resolveCodexModelCatalogPath("gpt-5.5"), undefined);

  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  const codexEntrypoint = path.join(path.dirname(packageJsonPath), "bin", "codex.js");
  const output = execFileSync(
    process.execPath,
    [
      codexEntrypoint,
      "debug",
      "models",
      "-c",
      `model_catalog_json=${JSON.stringify(terraCatalogPath)}`,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  const catalog = JSON.parse(output) as {
    models: Array<Record<string, unknown> & { slug: string }>;
  };
  const metadata = Object.fromEntries(catalog.models.map((model) => [model.slug, model]));

  assert.deepEqual(catalog.models.map((model) => model.slug).sort(), [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4.1-flash",
    "gpt-5.6-terra",
    "moonshotai/kimi-k3",
    "qwen/qwen3.5-flash-02-23",
    "qwen/qwen3.8-max-0902",
    "z-ai/glm-4.7-flash",
    "z-ai/glm-5.3",
  ]);
  assert.equal(metadata["qwen/qwen3.8-max-0902"]?.context_window, 1_000_000);
  assert.equal(metadata["qwen/qwen3.8-max-0902"]?.auto_compact_token_limit, 950_000);
  assert.equal(metadata["z-ai/glm-5.3"]?.context_window, 1_048_576);
  assert.equal(metadata["z-ai/glm-5.3"]?.auto_compact_token_limit, 996_147);
  assert.equal(metadata["z-ai/glm-5.3"]?.supports_parallel_tool_calls, false);
  assert.equal(metadata["z-ai/glm-5.3"]?.support_verbosity, false);
  assert.equal(metadata["gpt-5.6-terra"]?.context_window, 272_000);
  assert.equal(metadata["gpt-5.6-terra"]?.auto_compact_token_limit, 258_400);
  assert.equal(metadata["moonshotai/kimi-k3"]?.context_window, 1_048_576);
  assert.equal(metadata["moonshotai/kimi-k3"]?.auto_compact_token_limit, 996_147);
  assert.equal(metadata["deepseek/deepseek-v4.1-flash"]?.display_name, "DeepSeek V4.1 Flash");
  assert.equal(metadata["deepseek/deepseek-v4.1-flash"]?.context_window, 1_048_576);
  assert.equal(metadata["deepseek/deepseek-v4.1-flash"]?.auto_compact_token_limit, 996_147);
  assert.equal(metadata["deepseek/deepseek-v4.1-flash"]?.supports_parallel_tool_calls, false);
  assert.equal(metadata["z-ai/glm-4.7-flash"]?.display_name, "GLM 4.7 Flash");
  assert.equal(
    metadata["qwen/qwen3.5-flash-02-23"]?.display_name,
    "Qwen 3.5 Flash",
  );
  assert.equal(
    metadata["deepseek/deepseek-v4-flash"]?.display_name,
    "DeepSeek V4 Flash",
  );
});
