import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parseOaReadConfig } from "../config/oaReadConfig.js";
import { OaReadService } from "../infrastructure/oa-read/readService.js";

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  const config = parseOaReadConfig(process.env, repoRoot);
  if (!config) throw new Error("DATABASE_URL_READ 未配置");
  const service = new OaReadService(config);
  try {
    const report = await service.sync("manual");
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "rejected") process.exitCode = 1;
  } finally { await service.close(); }
}
main().catch(() => { console.error("OA 元数据同步失败；检查连接、元数据文件及 sync.lock（不输出数据库凭据）。"); process.exitCode = 1; });
