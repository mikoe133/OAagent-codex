import { startHttpServer } from "../api/httpServer.js";
import { AgentService } from "../application/agentService.js";
import { loadConfig } from "../config/config.js";
import { startModelRelay } from "../infrastructure/codex/modelRelay.js";
import { SessionStore } from "../infrastructure/persistence/sessionStore.js";

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const modelRelay = await startModelRelay(baseConfig.modelProviders);
  const config = { ...baseConfig, modelRelayBaseUrl: modelRelay.baseUrl };
  const sessionStore = new SessionStore(config.sessionStorePath);
  const agentService = new AgentService(config, sessionStore);

  console.error(`[agent] provider=${config.modelProvider} model=${config.model}`);
  console.error(`[model-relay] listening on ${modelRelay.baseUrl} (HTTP/1.1 upstream)`);
  console.error(`[agent] session_store=${config.sessionStorePath}`);
  console.error(
    config.automationApiToken
      ? "[automation] 专用模型目录与校验接口已启用。"
      : "[automation] 未配置 OA_AGENT_AUTOMATION_TOKEN，自动化接口不可用。",
  );
  console.error(
    config.oaApiBaseUrl
      ? "[agent] 受控 OA API 调用工具已启用;OA 登录态来自已验证的请求 token。"
      : "[agent] 未配置 OA_API_BASE_URL;本次只做接口分析,不执行真实 OA 请求。",
  );

  startHttpServer(config, agentService, sessionStore);
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
