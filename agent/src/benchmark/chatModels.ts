/** Live paid comparison through OAagent's prompt, Codex SDK, relay and read service.
 * Synthetic OA rows only. No production database or business API is contacted.
 * Run: npx tsx agent/src/benchmark/chatModels.ts --rounds=2
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../config/config.js";
import { buildTaskPrompt } from "../application/runCodexAgent.js";
import { resolveTaskReasoningEffort } from "../application/taskReasoningPolicy.js";
import { normalizeModelReasoningEffort } from "../config/modelCatalog.js";
import { createCodexClient, startOrResumeThread } from "../infrastructure/codex/codexClient.js";
import { startModelRelay } from "../infrastructure/codex/modelRelay.js";
import { OaReadService, readToolToken } from "../infrastructure/oa-read/readService.js";
import { parseMetadata, type SchemaSnapshot } from "../infrastructure/oa-read/metadata.js";
import type { ReadDatabase } from "../infrastructure/oa-read/database.js";
import { withDatabaseReadRouting } from "../infrastructure/oa-read/routing.js";
import { buildOpenApiIndex } from "../infrastructure/oa/openApiIndex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rounds = Number(process.argv.find(a => a.startsWith("--rounds="))?.split("=")[1] ?? 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error("rounds must be 1..5");
const output = path.join(root, "artifacts/chat-model-benchmark", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const base = loadConfig();
const models = ["z-ai/glm-5.3", "deepseek/deepseek-v4-flash"];
const cases = [
  { id: "rwkv", task: "rwkv 相比于传统 transformer 的优势。请用中文简洁回答，区分 prefill 与 KV cache 解码复杂度，给出适用场景和限制。", catalogs: ["rwkv_knowledge"] as const },
  { id: "project", task: "查询 Atlas 项目的当前状态、负责人姓名和最后更新时间，只回答查询结果。", catalogs: ["oa"] as const },
  { id: "statistics", task: "统计当前工程部和产品部各有多少成员、其中实习成员多少，以及两个部门合计人数；身份未知的成员单独说明，不能当作正式或实习。", catalogs: ["oa"] as const },
];
const temp = await mkdtemp(path.join(os.tmpdir(), "oa-chat-benchmark-"));
const semantic = parseMetadata({ format: 1, description: "Synthetic evaluation dataset", rules: ["所有数据均为测试样本。employee_type: regular=正式, intern=实习, unknown=身份未知。status: active=进行中, archived=归档。"], entities: [
  { name: "members", table: "user", description: "成员、部门、员工身份", access: "authenticated", columns: {
    id: { description: "成员 ID" }, full_name: { description: "姓名" }, department: { description: "部门名称" }, employee_type: { description: "regular 正式; intern 实习; unknown 未知，不得计入正式或实习" },
  }, references: [] },
  { name: "projects", table: "projects", description: "项目当前状态、负责人、更新时间", access: "authenticated", columns: {
    id: { description: "项目 ID" }, project_name: { description: "项目名称" }, status: { description: "active 进行中; archived 归档" }, owner_id: { description: "负责人 ID" }, updated_at: { description: "最后更新时间，Asia/Shanghai" },
  }, references: [{ column: "owner_id", entity: "members", targetColumn: "id" }] },
] });
const schema: SchemaSnapshot = { database: "benchmark", tables: semantic.entities.map(e => ({
  name: e.table, kind: "BASE TABLE", comment: "", columns: Object.keys(e.columns).map((name, i) => ({ name, type: name === "id" || name.endsWith("_id") ? "int" : "varchar(255)", nullable: "YES", defaultValue: null, comment: "", extra: "", ordinal: i + 1, collation: null, generation: "" })), indexes: [], foreignKeys: [], viewDefinition: null, dependencies: [],
})) };
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE user(id INTEGER, full_name TEXT, department TEXT, employee_type TEXT);
INSERT INTO user VALUES (7,'赵宁','工程部','regular'),(8,'陈珂','工程部','regular'),(9,'林悦','工程部','intern'),(10,'周衡','工程部','unknown'),(11,'许岚','产品部','regular'),(12,'何川','产品部','intern');
CREATE TABLE projects(id INTEGER, project_name TEXT, status TEXT, owner_id INTEGER, updated_at TEXT);
INSERT INTO projects VALUES(28,'Atlas','active',7,'2026-09-28 16:30:00'),(29,'Boreal','archived',11,'2026-09-20 09:00:00');`);
const readConfig = { databaseUrl: "mysql://fixture:fixture@127.0.0.1/benchmark", metadataPath: path.join(temp, "unused.json"), stateDirectory: path.join(temp, "read-state"), syncIntervalSeconds: 300, queryTimeoutMs: 10000, maxRows: 200, concurrency: 2 };
await mkdir(readConfig.stateDirectory);
await writeFile(path.join(readConfig.stateDirectory, "current.json"), JSON.stringify({ active: { version: "fixture-v1", publishedAt: "2026-09-29T00:00:00Z", schema, semantic }, report: { status: "published" } }));
const readDb = {
  read: async (fn: (query: (sql: string, values?: unknown[]) => Promise<unknown[]>) => Promise<unknown>) => fn(async (sql, values = []) => {
    if (!/^SELECT /i.test(sql)) throw new Error("Read-only benchmark");
    return db.prepare(sql).all(...values as (string | number | null)[]);
  }),
  close: async () => {},
} as unknown as ReadDatabase;
const service = new OaReadService(readConfig, readDb);
const sessions = new Set<string>();
const toolCalls = new Map<string, unknown[]>();
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body);
    if (req.url !== "/__internal/query-oa-database" || !sessions.has(input.sessionId) || req.headers.authorization !== `Bearer ${readToolToken("benchmark-capability", input.sessionId)}`) {
      res.writeHead(403); res.end("benchmark endpoint only"); return;
    }
    const result = await service.call(input, { userId: "7", isAdmin: false });
    toolCalls.get(input.sessionId)!.push({ input, result });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
  } catch { res.writeHead(400); res.end("invalid benchmark request"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const relay = await startModelRelay({ openrouter: base.modelProviders.openrouter });
const candidates = withDatabaseReadRouting(buildOpenApiIndex({ paths: {} })).operations;
const results: Record<string, unknown>[] = [];
try {
  for (let round = 0; round < rounds; round++) {
    for (const scenario of cases) {
      const order = round % 2 ? [...models].reverse() : models;
      await Promise.all(order.map(async model => {
        const id = `${scenario.id}-${round}-${model.replaceAll("/", "_")}`;
        const workspace = path.join(temp, id);
        const agentRoot = path.join(workspace, "agent");
        await mkdir(agentRoot, { recursive: true });
        await Promise.all(["prompts", "scripts", "metadata", "openapi", "knowledgebaseapi"].map(dir => cp(path.join(root, "agent", dir), path.join(agentRoot, dir), { recursive: true })));
        // Identical warm public-source cache for both models; eliminates internet-fetch variance.
        await cp(path.join(root, ".context/rwkv-knowledge"), path.join(workspace, ".context/rwkv-knowledge"), { recursive: true }).catch(() => undefined);
        sessions.add(id); toolCalls.set(id, []);
        const config = { ...base, repoRoot: workspace, projectRoot: agentRoot, openapiPath: path.join(agentRoot, "openapi/openapi.json"), knowledgeBaseOpenapiPath: path.join(agentRoot, "knowledgebaseapi/knowledgebaseapi.yaml"), modelProvider: "openrouter" as const, model, modelRelayBaseUrl: relay.baseUrl, serverPort: port, oaRead: readConfig, oaApiBaseUrl: `http://127.0.0.1:${port}`, oaApiToolToken: "benchmark-capability", knowledgeBaseApiToken: null, automationApiToken: null, codexSandboxMode: "workspace-write" as const };
        const effort = resolveTaskReasoningEffort(scenario.task);
        const prompt = buildTaskPrompt(config, scenario.task, { sessionId: id, hasSessionOaApiToken: true, selectedApiCatalogs: [...scenario.catalogs], openApiCandidates: scenario.id === "rwkv" ? [] : candidates });
        const thread = startOrResumeThread(createCodexClient(config, id), config, null, model, effort);
        const started = performance.now();
        const trace: unknown[] = [];
        let firstActivityMs: number | null = null, firstTextMs: number | null = null, finalTextMs: number | null = null;
        let answer = "", usage: unknown, failure: string | null = null, commands = 0;
        console.log(JSON.stringify({ event: "started", model, case: scenario.id, round, reasoning: normalizeModelReasoningEffort(model, effort) }));
        try {
          const { events } = await thread.runStreamed(prompt, { signal: AbortSignal.timeout(240000) });
          for await (const event of events) {
            const ms = Math.round(performance.now() - started);
            if ("item" in event) {
              const item = event.item;
              if (firstActivityMs === null && (item.type === "command_execution" || item.type === "agent_message")) firstActivityMs = ms;
              if (item.type === "agent_message" && item.text) {
                firstTextMs ??= ms;
                if (event.type === "item.completed") { answer = item.text; finalTextMs = ms; }
              }
              if (event.type === "item.completed" && item.type === "command_execution") commands++;
            }
            if (event.type === "turn.completed") usage = event.usage;
            if (event.type === "turn.failed") failure = event.error.message;
            if (event.type === "error") failure = event.message;
            trace.push({ ms, ...event });
          }
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        const result = { model, case: scenario.id, round, reasoning: normalizeModelReasoningEffort(model, effort), totalMs: Math.round(performance.now() - started), firstActivityMs, firstTextMs, finalTextMs, commands, answer, failure, usage, toolCalls: toolCalls.get(id), trace };
        const serialized = JSON.stringify(result, null, 2).replaceAll(base.modelProviders.openrouter.apiKey, "[REDACTED]");
        await writeFile(path.join(output, `${id}.json`), serialized);
        results.push(result);
        console.log(JSON.stringify({ event: "completed", model, case: scenario.id, round, totalMs: result.totalMs, firstTextMs, commands, failure }));
      }));
    }
  }
} finally {
  await writeFile(path.join(output, "summary.json"), JSON.stringify({ scenarios: cases, rounds, notes: "Current production prompt, reasoning normalization, Codex SDK and HTTP/1.1 relay. Routing fixed equally across models; synthetic data via real OaReadService/compiler with SQLite fixture; not a production DB latency measurement. RWKV warm cache.", results: results.map(({ trace, ...r }) => r) }, null, 2));
  await relay.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await service.close(); db.close();
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, completed: results.length }));
