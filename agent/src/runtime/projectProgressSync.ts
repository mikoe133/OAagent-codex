import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  ResponsesProjectProgressSummarizer,
} from "../application/projectProgressSummarizer.js";
import { syncProjectProgress } from "../application/syncProjectProgress.js";
import { loadProjectProgressConfig } from "../config/projectProgressConfig.js";
import { GitHubRestProjectReader } from "../infrastructure/github/githubClient.js";
import { ProjectProgressOaClient } from "../infrastructure/oa/projectProgressOaClient.js";
import { ProjectProgressStore } from "../infrastructure/persistence/projectProgressStore.js";
import { parseProjectProgressOptions } from "./projectProgressOptions.js";

async function main(): Promise<void> {
  const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = path.resolve(agentRoot, "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(agentRoot, ".env"), override: true });
  const options = parseProjectProgressOptions(process.argv.slice(2));
  const config = loadProjectProgressConfig(process.env, repoRoot);
  if (options.writeMode === "unsafe-test" && !config.writeEnabled) {
    throw new Error(
      "--apply-test 需要 PROJECT_PROGRESS_WRITE_ENABLED=true 和测试写入确认变量。",
    );
  }
  const store = new ProjectProgressStore(config.stateDatabasePath);

  try {
    const report = await syncProjectProgress({
      observedAt: options.observedAt ?? new Date(),
      oaClient: new ProjectProgressOaClient(config.oa),
      githubReader: new GitHubRestProjectReader(
        config.githubToken,
        fetch,
        config.githubApiBaseUrl,
      ),
      summarizer: new ResponsesProjectProgressSummarizer(config.model),
      store,
      writeMode: options.writeMode,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`项目进度 dry-run 失败:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
