import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { resolveCodexModelCatalogPath } from "../src/infrastructure/codex/modelMetadataCatalog.js";

test("loads custom Codex metadata for Terra and Kimi only", () => {
  const terraCatalogPath = resolveCodexModelCatalogPath("gpt-5.6-terra");
  const kimiCatalogPath = resolveCodexModelCatalogPath("moonshotai/kimi-k3");

  assert.ok(terraCatalogPath);
  assert.equal(kimiCatalogPath, terraCatalogPath);
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
    "gpt-5.6-terra",
    "moonshotai/kimi-k3",
  ]);
  assert.equal(metadata["gpt-5.6-terra"]?.context_window, 272_000);
  assert.equal(metadata["gpt-5.6-terra"]?.auto_compact_token_limit, 258_400);
  assert.equal(metadata["moonshotai/kimi-k3"]?.context_window, 1_048_576);
  assert.equal(metadata["moonshotai/kimi-k3"]?.auto_compact_token_limit, 996_147);
});
