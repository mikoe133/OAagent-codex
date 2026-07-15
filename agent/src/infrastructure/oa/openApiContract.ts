import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config/config.js";

const OPENAPI_FETCH_TIMEOUT_MS = 5_000;

export type ResolvedOpenApiContract = {
  document: unknown;
  path: string;
  source: "remote" | "local";
  fallbackReason?: string;
};

type OpenApiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function resolveOpenApiContract(
  config: AppConfig,
  fetchImpl: OpenApiFetch = fetch,
): Promise<ResolvedOpenApiContract> {
  try {
    const document = await fetchRemoteContract(config.openapiUrl, fetchImpl);
    return {
      document,
      path: await materializeRemoteContract(config.projectRoot, document),
      source: "remote",
    };
  } catch (error) {
    const document = parseOpenApiDocument(
      await readFile(config.openapiPath, "utf8"),
      `本地 OpenAPI 文件 ${config.openapiPath}`,
    );
    return {
      document,
      path: config.openapiPath,
      source: "local",
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchRemoteContract(
  openapiUrl: string,
  fetchImpl: OpenApiFetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAPI_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(openapiUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`远程 OpenAPI 请求失败:HTTP ${response.status}`);
    }
    return parseOpenApiDocument(await response.text(), "远程 OpenAPI 响应");
  } finally {
    clearTimeout(timeout);
  }
}

async function materializeRemoteContract(
  projectRoot: string,
  document: unknown,
): Promise<string> {
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  const digest = createHash("sha256").update(contents).digest("hex");
  const cacheDirectory = path.join(projectRoot, ".context", "openapi");
  const contractPath = path.join(cacheDirectory, `${digest}.json`);
  const temporaryPath = path.join(
    cacheDirectory,
    `.${digest}-${randomUUID()}.tmp`,
  );

  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(temporaryPath, contents, "utf8");
  try {
    await rename(temporaryPath, contractPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return contractPath;
}

function parseOpenApiDocument(contents: string, source: string): unknown {
  let document: unknown;
  try {
    document = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} 不是合法 JSON:${message}`);
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
