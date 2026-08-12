import { startHttpServer } from "../api/httpServer.js";
import { AgentService } from "../application/agentService.js";
import { AutomationHttpApplication } from "../automation/http/automationHttpApplication.js";
import { AutomationService } from "../automation/application/automationService.js";
import { AutomationMaintenance } from "../automation/application/automationMaintenance.js";
import { createAutomationDatabase } from "../automation/persistence/database.js";
import { runAutomationMigrations } from "../automation/persistence/migrations.js";
import { loadConfig } from "../config/config.js";
import { startModelRelay } from "../infrastructure/codex/modelRelay.js";
import { SessionStore } from "../infrastructure/persistence/sessionStore.js";

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const modelRelay = await startModelRelay(baseConfig.modelProviders);
  const config = { ...baseConfig, modelRelayBaseUrl: modelRelay.baseUrl };
  const sessionStore = new SessionStore(config.sessionStorePath);
  const agentService = new AgentService(config, sessionStore);
  let automationDatabase: ReturnType<typeof createAutomationDatabase> | null = null;
  let automationMaintenance: AutomationMaintenance | null = null;
  let automationHttp: AutomationHttpApplication | undefined;

  if (config.automation.databaseUrl) {
    if (!config.automationApiToken) {
      throw new Error(
        "配置 DATABASE_URL 时必须同时配置 OA_AGENT_AUTOMATION_TOKEN。",
      );
    }
    if (!config.automation.sessionSecret) {
      throw new Error("配置 DATABASE_URL 时必须同时配置 OA_SESSION_SECRET。");
    }
    if (config.automation.migrateOnStart) {
      const migration = await runAutomationMigrations(
        config.automation.databaseUrl,
        config.repoRoot,
      );
      console.error(
        `[automation-migrate] baseline=${migration.baselineApplied ? "applied" : "existing"} seed=applied`,
      );
    }
    automationDatabase = createAutomationDatabase(config.automation.databaseUrl);
    const automationService = new AutomationService(automationDatabase, {
      modelProvider: config.modelProvider,
      model: config.model,
      modelProviders: config.modelProviders,
      scheduleGraceSeconds: config.automation.scheduleGraceSeconds,
      manualTriggerLimit: config.automation.manualTriggerLimit,
      manualTriggerWindowSeconds:
        config.automation.manualTriggerWindowSeconds,
    });
    automationHttp = new AutomationHttpApplication(
      {
        sessionSecret: config.automation.sessionSecret,
        sessionVerifyMaxAgeSeconds:
          config.automation.sessionVerifyMaxAgeSeconds,
        internalToken: config.automationApiToken,
      },
      automationService,
    );
    if (config.automation.maintenanceEnabled) {
      automationMaintenance = new AutomationMaintenance(
        automationService,
        config.automation.maintenanceIntervalSeconds,
      );
      automationMaintenance.start();
    }
  }

  console.error(`[agent] provider=${config.modelProvider} model=${config.model}`);
  console.error(`[model-relay] listening on ${modelRelay.baseUrl} (HTTP/1.1 upstream)`);
  console.error(`[agent] session_store=${config.sessionStorePath}`);
  console.error(
    config.automationApiToken
      ? "[automation] 专用模型目录与校验接口已启用。"
      : "[automation] 未配置 OA_AGENT_AUTOMATION_TOKEN，自动化接口不可用。",
  );
  console.error(
    automationDatabase
      ? `[automation] MySQL 存储已启用;maintenance=${config.automation.maintenanceEnabled}`
      : "[automation] 未配置 DATABASE_URL;自动任务存储接口未启用。",
  );
  console.error(
    config.oaApiBaseUrl
      ? "[agent] 受控 OA API 调用工具已启用;OA 登录态来自已验证的请求 token。"
      : "[agent] 未配置 OA_API_BASE_URL;本次只做接口分析,不执行真实 OA 请求。",
  );

  const server = startHttpServer(
    config,
    agentService,
    sessionStore,
    automationHttp,
  );
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[server] received ${signal}, shutting down`);
    automationMaintenance?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await automationDatabase?.close();
    await modelRelay.close();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
