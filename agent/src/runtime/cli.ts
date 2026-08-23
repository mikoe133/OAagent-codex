import { runCodexAgent } from "../application/runCodexAgent.js";
import { loadConfig } from "../config/config.js";
import { startModelRelay } from "../infrastructure/codex/modelRelay.js";
import { resolveOpenApiContract } from "../infrastructure/oa/openApiContract.js";
import { routeOpenApiRequest } from "../infrastructure/oa/openApiRouter.js";
import { mergeOpenApiIndexes } from "../infrastructure/oa/openApiIndex.js";
import { resolveKnowledgeBaseContracts } from "../infrastructure/knowledgebase/knowledgeBaseContract.js";

async function main(): Promise<void> {
  const userTask = process.argv.slice(2).join(" ").trim();
  if (!userTask) {
    console.error('用法: npm run dev -- "我想查一下周报列表,应该调用哪个接口?"');
    process.exitCode = 1;
    return;
  }

  let baseConfig;
  try {
    baseConfig = loadConfig();
  } catch (error) {
    console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  console.error(`[agent] provider=${baseConfig.modelProvider} model=${baseConfig.model}`);
  console.error("[agent] 当前未注册 OA 调用工具;本次只做接口分析,不执行真实 OA 请求。");

  const [openapi, knowledgeBase] = await Promise.all([
    resolveOpenApiContract(baseConfig),
    resolveKnowledgeBaseContracts(baseConfig),
  ]);
  console.error(
    openapi.source === "remote"
      ? `[agent] OpenAPI 使用远程地址:${baseConfig.openapiUrl}`
      : `[agent] 远程 OpenAPI 不可用,使用本地文件:${baseConfig.openapiPath}`,
  );
  const modelRelay = await startModelRelay(baseConfig.modelProviders);
  const config = { ...baseConfig, modelRelayBaseUrl: modelRelay.baseUrl };
  let result;
  try {
    const route = await routeOpenApiRequest(
      config,
      mergeOpenApiIndexes([
        openapi.index,
        knowledgeBase.read.index,
        ...(knowledgeBase.write ? [knowledgeBase.write.index] : []),
      ]),
      { task: userTask, conversationMemory: null },
    );
    result = await runCodexAgent(
      { ...config, openapiPath: openapi.path },
      userTask,
      {
        openApiCandidates: route.candidates,
        selectedApiCatalogs: route.catalogs,
        knowledgeBaseWriteContractAvailable: knowledgeBase.write !== null,
      },
    );
  } finally {
    await modelRelay.close();
  }

  if (result.executedCommands.length > 0) {
    console.error("[agent] 过程记录(执行过的命令):");
    for (const command of result.executedCommands) {
      console.error(`  $ ${command}`);
    }
  }

  console.log(result.finalResponse);
}

main().catch((error: unknown) => {
  // 运行期错误(模型、provider、codex 子进程)保留完整错误对象便于排查。
  console.error("运行失败:", error);
  process.exitCode = 1;
});
