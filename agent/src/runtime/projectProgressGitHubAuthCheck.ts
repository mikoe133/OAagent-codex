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

try {
  const auth = createGitHubAppAuth({
    appId,
    privateKey: await readFile(privateKeyPath, "utf8"),
  });
  const installations = await auth.describeAccess(AbortSignal.timeout(60_000));
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
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`GitHub App 鉴权检查失败:${sanitize(message)}`);
}

function sanitize(value: string): string {
  return value
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}
