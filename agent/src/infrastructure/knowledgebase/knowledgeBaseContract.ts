import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { AppConfig } from "../../config/config.js";
import {
  buildOpenApiIndex,
  type OpenApiCatalog,
  type OpenApiOperationIndex,
} from "../oa/openApiIndex.js";

export type ResolvedKnowledgeBaseContract = {
  document: unknown;
  index: OpenApiOperationIndex;
  path: string;
  catalog: Extract<
    OpenApiCatalog,
    "knowledge_base_read" | "knowledge_base_write"
  >;
};

export type ResolvedKnowledgeBaseContracts = {
  read: ResolvedKnowledgeBaseContract;
  write: ResolvedKnowledgeBaseContract | null;
  writePath: string;
  guidePath: string;
};

export async function resolveKnowledgeBaseContracts(
  config: AppConfig,
): Promise<ResolvedKnowledgeBaseContracts> {
  const [read, write] = await Promise.all([
    loadContract(config.knowledgeBaseReadOpenapiPath, "knowledge_base_read"),
    loadOptionalWriteContract(config.knowledgeBaseWriteOpenapiPath),
  ]);
  return {
    read,
    write,
    writePath: config.knowledgeBaseWriteOpenapiPath,
    guidePath: config.knowledgeBaseApiGuidePath,
  };
}

async function loadOptionalWriteContract(
  contractPath: string,
): Promise<ResolvedKnowledgeBaseContract | null> {
  try {
    return await loadContract(contractPath, "knowledge_base_write");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function loadContract(
  contractPath: string,
  catalog: ResolvedKnowledgeBaseContract["catalog"],
): Promise<ResolvedKnowledgeBaseContract> {
  const contents = await readFile(contractPath, "utf8");
  const document = parseKnowledgeBaseOpenApiDocument(contents, contractPath);
  return {
    document,
    index: buildOpenApiIndex(document, catalog),
    path: contractPath,
    catalog,
  };
}

function parseKnowledgeBaseOpenApiDocument(
  contents: string,
  source: string,
): unknown {
  let document: unknown;
  try {
    document = parseYaml(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} 不是合法 YAML/JSON:${message}`);
  }
  if (
    !isRecord(document) ||
    (typeof document.openapi !== "string" &&
      typeof document.swagger !== "string") ||
    !isRecord(document.paths)
  ) {
    throw new Error(`${source} 不是合法 OpenAPI 文档。`);
  }
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
