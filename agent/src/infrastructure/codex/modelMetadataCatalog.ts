import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

type CustomModelDefinition = {
  baseSlug: string;
  displayName: string;
  description: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  supportsParallelToolCalls: boolean;
  supportVerbosity: boolean;
};

const CUSTOM_MODEL_DEFINITIONS = {
  "z-ai/glm-4.7-flash": {
    baseSlug: "gpt-5.5",
    displayName: "GLM 4.7 Flash",
    description: "Z.ai GLM 4.7 Flash semantic router served through OpenRouter.",
    contextWindow: 202_752,
    autoCompactTokenLimit: 192_614,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
  "z-ai/glm-5.3": {
    baseSlug: "gpt-5.5",
    displayName: "GLM 5.3",
    description: "Z.ai GLM 5.3 served through OpenRouter.",
    contextWindow: 1_048_576,
    autoCompactTokenLimit: 996_147,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
  "gpt-5.6-terra": {
    baseSlug: "gpt-5.5",
    displayName: "GPT-5.6 Terra",
    description: "Nexttoken GPT-5.6 Terra coding model.",
    contextWindow: 272_000,
    autoCompactTokenLimit: 258_400,
    supportsParallelToolCalls: true,
    supportVerbosity: true,
  },
  "moonshotai/kimi-k3": {
    baseSlug: "gpt-5.5",
    displayName: "Kimi K3",
    description: "MoonshotAI Kimi K3 served through OpenRouter.",
    contextWindow: 1_048_576,
    autoCompactTokenLimit: 996_147,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
  "qwen/qwen3.5-flash-02-23": {
    baseSlug: "gpt-5.5",
    displayName: "Qwen 3.5 Flash",
    description: "Alibaba Qwen 3.5 Flash semantic router served through OpenRouter.",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 950_000,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
  "deepseek/deepseek-v4-flash": {
    baseSlug: "gpt-5.5",
    displayName: "DeepSeek V4 Flash",
    description: "DeepSeek V4 Flash semantic router served through OpenRouter.",
    contextWindow: 1_048_576,
    autoCompactTokenLimit: 996_147,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
  "deepseek/deepseek-v4-pro": {
    baseSlug: "gpt-5.5",
    displayName: "DeepSeek V4 Pro",
    description: "DeepSeek V4 Pro served through OpenRouter.",
    contextWindow: 1_048_576,
    autoCompactTokenLimit: 996_147,
    supportsParallelToolCalls: false,
    supportVerbosity: false,
  },
} as const satisfies Record<string, CustomModelDefinition>;

type CustomModelId = keyof typeof CUSTOM_MODEL_DEFINITIONS;
type ModelInfo = Record<string, unknown> & { slug: string };
type ModelCatalog = { models: ModelInfo[] };

let generatedCatalogPath: string | null = null;
let generatedCatalogDirectory: string | null = null;

export function resolveCodexModelCatalogPath(model: string): string | undefined {
  if (!isCustomModelId(model)) {
    return undefined;
  }
  generatedCatalogPath ??= generateModelCatalogFile();
  return generatedCatalogPath;
}

export function buildCustomModelCatalog(bundledCatalog: unknown): ModelCatalog {
  const bundledModels = decodeModelCatalog(bundledCatalog).models;
  const models = Object.entries(CUSTOM_MODEL_DEFINITIONS).map(
    ([slug, definition]) => {
      const baseModel = bundledModels.find((model) => model.slug === definition.baseSlug);
      if (!baseModel) {
        throw new Error(`Codex bundled catalog 缺少基础模型 ${definition.baseSlug}。`);
      }
      return {
        ...structuredClone(baseModel),
        slug,
        display_name: definition.displayName,
        description: definition.description,
        visibility: "hide",
        supported_in_api: true,
        priority: 100,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        context_window: definition.contextWindow,
        max_context_window: definition.contextWindow,
        auto_compact_token_limit: definition.autoCompactTokenLimit,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: definition.supportsParallelToolCalls,
        support_verbosity: definition.supportVerbosity,
        supports_image_detail_original: false,
        supports_search_tool: false,
      } satisfies ModelInfo;
    },
  );
  return { models };
}

function generateModelCatalogFile(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  const codexEntrypoint = path.join(path.dirname(packageJsonPath), "bin", "codex.js");
  let bundledCatalog: unknown;
  try {
    const output = execFileSync(
      process.execPath,
      [codexEntrypoint, "debug", "models", "--bundled"],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    bundledCatalog = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error("无法读取 Codex bundled model catalog。", { cause: error });
  }

  const catalog = buildCustomModelCatalog(bundledCatalog);
  generatedCatalogDirectory = mkdtempSync(path.join(tmpdir(), "oaagent-codex-models-"));
  const catalogPath = path.join(generatedCatalogDirectory, "models.json");
  writeFileSync(catalogPath, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
  return catalogPath;
}

function decodeModelCatalog(value: unknown): ModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("Codex bundled model catalog 格式无效。");
  }
  const models = value.models.filter(
    (model): model is ModelInfo => isRecord(model) && typeof model.slug === "string",
  );
  if (models.length !== value.models.length) {
    throw new Error("Codex bundled model catalog 包含无效模型条目。");
  }
  return { models };
}

function isCustomModelId(model: string): model is CustomModelId {
  return Object.prototype.hasOwnProperty.call(CUSTOM_MODEL_DEFINITIONS, model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

process.once("exit", () => {
  if (generatedCatalogDirectory) {
    try {
      rmSync(generatedCatalogDirectory, { recursive: true, force: true });
    } catch {
      // Process shutdown should not fail because temporary cleanup is unavailable.
    }
  }
});
