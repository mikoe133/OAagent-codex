import { loadConfig } from "./config.js";
import { AgentService } from "./server/agentService.js";
import { startHttpServer } from "./server/httpServer.js";
import { SessionStore } from "./server/sessionStore.js";

function main(): void {
  const config = loadConfig();
  const sessionStore = new SessionStore(config.sessionStorePath);
  const agentService = new AgentService(config, sessionStore);

  console.error(`[agent] provider=${config.modelProvider} model=${config.model}`);
  console.error(`[agent] session_store=${config.sessionStorePath}`);
  console.error(
    config.oaApiBaseUrl
      ? "[agent] 受控 OA API 调用工具已启用;OA 登录态可来自请求 header 或服务端环境变量。"
      : "[agent] 未配置 OA_API_BASE_URL;本次只做接口分析,不执行真实 OA 请求。",
  );

  startHttpServer(config, agentService, sessionStore);
}

try {
  main();
} catch (error) {
  console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
