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
};

export async function resolveKnowledgeBaseContracts(
  config: AppConfig,
): Promise<ResolvedKnowledgeBaseContracts> {
  const document = await loadDocument(config.knowledgeBaseOpenapiPath);
  const read = buildCatalogContract(
    document,
    config.knowledgeBaseOpenapiPath,
    "knowledge_base_read",
  );
  const write = buildCatalogContract(
    document,
    config.knowledgeBaseOpenapiPath,
    "knowledge_base_write",
  );
  return {
    read,
    write: write.index.operations.length > 0 ? write : null,
  };
}

function buildCatalogContract(
  document: unknown,
  contractPath: string,
  catalog: ResolvedKnowledgeBaseContract["catalog"],
): ResolvedKnowledgeBaseContract {
  const index = buildOpenApiIndex(document, catalog);
  return {
    document,
    index: {
      ...index,
      operations: index.operations.filter((operation) =>
        catalog === "knowledge_base_read"
          ? operation.method === "GET"
          : operation.method !== "GET",
      ),
    },
    path: contractPath,
    catalog,
  };
}

async function loadDocument(contractPath: string): Promise<unknown> {
  const contents = await readFile(contractPath, "utf8");
  return parseKnowledgeBaseOpenApiDocument(contents, contractPath);
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
