import { loadConfig } from "../config/config.js";
import { runAutomationMigrations } from "../automation/persistence/migrations.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.automation.databaseUrl) {
    throw new Error("缺少 DATABASE_URL，无法执行 automation migration。");
  }
  const result = await runAutomationMigrations(
    config.automation.databaseUrl,
    config.repoRoot,
  );
  console.error(
    `[automation-migrate] baseline=${result.baselineApplied ? "applied" : "existing"} seed=applied tables=${result.tables.length}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

