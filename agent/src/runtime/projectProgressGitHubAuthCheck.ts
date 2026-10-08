import { readFile } from "node:fs/promises";
import { createGitHubAppAuth } from "../infrastructure/github/githubAppAuth.js";

const appId = process.env.PROJECT_PROGRESS_GITHUB_APP_ID?.trim();
const privateKeyPath = process.env.PROJECT_PROGRESS_GITHUB_APP_PRIVATE_KEY_PATH?.trim();

if (!appId) {
  throw new Error("缺少 PROJECT_PROGRESS_GITHUB_APP_ID。");
}
if (!privateKeyPath) {
  throw new Error("缺少 PROJECT_PROGRESS_GITHUB_APP_PRIVATE_KEY_PATH。");
}

const started = performance.now();
const deadline = AbortSignal.timeout(60_000);
let phase = "private_key";
try {
  const auth = createGitHubAppAuth({
    appId,
    privateKey: await readFile(privateKeyPath, "utf8"),
  });
  phase = "github_access";
  const installations = await auth.describeAccess(deadline);
  phase = "permissions";
  const repositoryCount = installations.reduce(
    (total, installation) => total + installation.repositories.length,
    0,
  );
  if (installations.length === 0) {
    throw new Error("GitHub App 当前没有 installation。");
  }
  if (repositoryCount === 0) {
    throw new Error("GitHub App 当前没有可访问仓库。");
  }
  if (installations.some((installation) => installation.permissions.contents !== "read")) {
    throw new Error("GitHub App installation 缺少 Contents: Read 权限。");
  }
  console.log(JSON.stringify({
    githubAppAuthenticated: true,
    installationCount: installations.length,
    repositoryCount,
    durationMs: Math.round(performance.now() - started),
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const reason = deadline.aborted
    ? "GitHub App 访问检查超过 60 秒总时限（请求、重试、限流等待及仓库分页共用预算）"
    : "GitHub App 鉴权检查失败";
  const details = phase === "github_access" ? "；请求阶段见 github_app_request_failed 日志。" : "";
  throw new Error(`${reason}:${sanitize(message)}${details}`);
}

function sanitize(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}
