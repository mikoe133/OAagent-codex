# GitHub 项目进度 Worker

OA 是调度事实来源：OA 按任务配置在工作日 20:00 创建运行，OAagent Worker 常驻轮询并 claim。完整接口字段见 [OAagent 集成 API](oaagent_integration_api.md)。

## 执行规则

1. claim 成功后先上报 `running`，并按约 60 秒发送 heartbeat。
2. 使用项目同步接口分页读取项目；`archived` 项目不读取详情或 GitHub。
3. 规范化、去重全部 `github_urls`，通过全局并发 6 的请求池读取各仓库分支的提交记录。
4. 任一仓库读取失败时不生成部分总结，也不自动降级项目状态。
5. 只为 `Asia/Shanghai` 当天实际有 Commit 的仓库创建 Codex Thread；每仓库一个，同时最多运行 2 个。
6. 同一项目的仓库结果全部完成后再聚合，同一项目每天最多写入一条总结。
7. 最近一次提交距计划执行时间达到 240 小时，状态改为 `maintenance`；维护中项目再次出现提交时改为 `updating`。
8. Codex Agent 先阅读单仓库当天候选 Commit，再按需调用受限的 `read_commit_details` 工具；工具只允许本批次仓库与 SHA，返回裁剪后的文件名、增删统计和 Patch 片段。
9. 项目结果和每个仓库 Thread 的 AI interaction 使用稳定幂等键写入 OA；OA mutation 全局并发固定为 1。
10. 收到取消请求或失去租约时，立即取消排队和在途 Thread，并停止后续业务写入。

已有人工总结不会被覆盖。Worker 只更新本地持久化状态确认由它管理、且未被人工修改的记录；并发创建冲突会按项目和日期重新查询后处理。

## 必需配置

```dotenv
AUTOMATION_API_BASE_URL=http://127.0.0.1:3002
PROJECT_SYNC_API_BASE_URL=http://127.0.0.1:8010
OA_AGENT_AUTOMATION_TOKEN=<自动化服务 token>
OA_PROJECT_SYNC_TOKEN=<项目同步服务 token>
OA_PROJECT_SYNC_TOKEN_HEADER=Authorization
OA_PROJECT_SYNC_TOKEN_PREFIX=Bearer
PROJECT_PROGRESS_GITHUB_TOKEN=<GitHub fine-grained PAT>
PROJECT_PROGRESS_WRITE_ENABLED=true
PROJECT_PROGRESS_PRODUCTION_WRITES=I_UNDERSTAND_PRODUCTION_WRITES
PROJECT_PROGRESS_WORKER_INSTANCE=oaagent-local-01
PROJECT_PROGRESS_LEASE_SECONDS=300
PROJECT_PROGRESS_HEARTBEAT_SECONDS=10
PROJECT_PROGRESS_GITHUB_CONCURRENCY=6
PROJECT_PROGRESS_GITHUB_MAX_BRANCHES=500
PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH=100
PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY=2000
PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN=20000
PROJECT_PROGRESS_AGENT_CONCURRENCY=2
PROJECT_PROGRESS_OA_WRITE_CONCURRENCY=1
PROJECT_PROGRESS_WORKSPACE_ROOT=/app/.context/project-progress-workspaces
PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS=12
PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT=20
PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE=1200
PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS=12000
```

`AUTOMATION_API_BASE_URL` 指向 Node 自动任务服务，用于 claim、heartbeat、运行结果、Trace 和 AI 审计。`PROJECT_SYNC_API_BASE_URL` 指向原 OA，用于查询项目/GitHub URL、写 Commit 总结和更新项目状态。未配置这两个变量时，Worker 会兼容回退到 `OA_API_BASE_URL`。

GitHub PAT 只需目标仓库的 `Metadata: Read` 和 `Contents: Read`。两个 OA token 用途不同，不能互换，也不能使用用户 `sessionid`。

GitHub PAT 只保留在 Worker 内存。每个活跃仓库会在 `127.0.0.1` 随机端口启动一个临时 MCP 服务，Codex 子进程只收到一次性 Bearer token；Agent turn 结束后服务立即关闭，隔离工作区随即清理。默认最多分析 50 条候选 Commit、读取 12 条详情、每条返回 20 个文件、单文件 1200 个 Patch 字符、单仓库合计 12000 个 Patch 字符。预算和并发参数使用 GitHub Environment Variables，不需要新增 Secret。

一个 Worker 内只有 2 个 Codex Thread 同时运行。GitHub 仓库扫描和所有 Thread 的 Commit 详情请求共享同一个 token 级执行器：全局并发 6、单仓库并发最多 6；同一分支的 Commit 分页仍保持串行。执行器统一处理 429/受限 403/5xx 瞬态重试、`Retry-After` 暂停和 run/仓库请求预算。分支、Commit 页数或请求预算耗尽时仓库会标记为 `incomplete`，不会生成部分总结。OA 总结、状态和审计写入按顺序执行。容器建议至少分配 `2 CPU / 3GB`。

项目总结 Agent 使用隔离的 Codex `exec`：忽略用户级配置和规则、不持久化 thread、禁用 shell、网页、插件能力及多 Agent，并固定 65536 token 上下文窗口和 6000 token 工具输出上限。若运行记录出现任何未授权工具调用，OAagent 会拒绝该输出并使用确定性兜底，同时把越权计数写入 AI interaction 审计。

模型由 OA run 快照选择，OAagent 只保存供应商地址和密钥：

```dotenv
NEXTTOKEN_API_KEY=<模型密钥>
OPENROUTER_API_KEY=<模型密钥>
```

当前 OA 契约只下发空的 `model_parameters={}`；OAagent 会严格校验 provider 和 model 是否在目录中。

## 本地联调

启动 OAagent HTTP 服务：

```bash
PORT=3001 npm run dev:server
```

验证模型目录和模型选择：

```bash
curl --fail-with-body \
  --header "Authorization: Bearer $OA_AGENT_AUTOMATION_TOKEN" \
  http://127.0.0.1:3001/internal/v1/models

curl --fail-with-body \
  --header "Authorization: Bearer $OA_AGENT_AUTOMATION_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"provider":"nexttoken","model_id":"gpt-5.6-terra"}' \
  http://127.0.0.1:3001/internal/v1/models/validate
```

在 OA 创建或手动触发任务后运行一次 Worker：

```bash
npm run run:project-progress-worker
```

该命令会常驻轮询 OA 队列；按 `Ctrl+C` 可安全停止。只执行一轮诊断时使用 `npm run run:project-progress-worker -- --once`，无任务会输出 `idle`。claim 到任务后应依次看到 `running`、项目结果、AI 审计和终态记录；原始 `lease_token` 不得出现在输出中。

只读排查 GitHub 或项目映射时仍可使用：

```bash
npm run sync:project-progress -- --project-id 62
```

该命令不参与 OA 自动化调度，只用于诊断。

手动触发会跳过当日草稿和仓库总结缓存，重新生成总结，并覆盖同一项目、同一日期下唯一的一条 OA 总结。只有 Agent/模型总结失败会创建自动重试；GitHub 读取或配置错误、OA 写入失败和任务超时都不会自动重试。重试会绕过总结缓存重新调用模型，但只更新当前 Worker 已托管的总结；存在多条同日总结时，任何来源都不会自动覆盖。

## 服务器轮询

Compose 的 `project-progress-worker` 默认常驻运行，并随 `docker compose up -d` 启动和自动恢复，不需要额外安装定时器。以下 systemd timer 仅用于尚未迁移的旧部署，它会通过 `--once` 每分钟执行一次，并用 `flock` 保证单实例：

```bash
bash scripts/install-project-progress-timer.sh \
  /opt/rwkv/apps/oa-agent-prod \
  <部署用户>
```

```bash
systemctl list-timers oa-agent-project-progress.timer
systemctl status oa-agent-project-progress.timer
journalctl -u oa-agent-project-progress.service -n 200 --no-pager
```

停止轮询不会删除数据：

```bash
sudo systemctl disable --now oa-agent-project-progress.timer
```

不要执行 `docker compose down -v`，否则会删除 Worker 幂等状态所在的数据卷。
