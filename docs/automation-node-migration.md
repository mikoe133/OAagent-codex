# Automation Node Migration

自动任务系统已经集成进现有 `agent` Node.js + TypeScript 服务，不创建独立 automation 服务。前端和 `project-progress-worker` 的 automation 流量走同一个 `agent` 容器，项目与 GitHub 总结仍走原 OA。

```text
agent 进程
├─ Agent 聊天接口
├─ 自动任务用户接口
├─ 自动任务内部接口
├─ MySQL/Kysely 数据访问
└─ automation maintenance

独立进程
└─ project-progress-worker
```

## Runtime Routing

```dotenv
AUTOMATION_API_BASE_URL=http://agent:3000
PROJECT_SYNC_API_BASE_URL=http://old-oa-server
OA_AGENT_AUTOMATION_TOKEN=<与 Node 一致>
OA_PROJECT_SYNC_TOKEN=<与原 OA 一致>
```

前端 BFF `/api/automation/*` 优先使用 `AUTOMATION_API_BASE_URL`，继续把 `sessionid` 作为 Cookie 传给上游。OAagent Worker 使用 `AUTOMATION_API_BASE_URL` 调用 claim、heartbeat、运行结果、Trace 和 AI 审计接口；使用 `PROJECT_SYNC_API_BASE_URL` 查询项目/GitHub URL、写 Commit 总结和更新项目状态。

Compose 已将前端和 Worker 的 `AUTOMATION_API_BASE_URL` 固定为 `http://agent:3000`。`PROJECT_SYNC_API_BASE_URL` 继续指向原 OA。

## Database

Node 自动任务库只执行下列 SQL。`DATABASE_URL` 由部署平台 Secret 注入，迁移器读取后按顺序执行：

```text
scripts/sql/001_automation_schema_baseline.up.sql
scripts/sql/003_automation_run_execution_parameters.up.sql
scripts/sql/004_automation_event_triggers.up.sql
scripts/sql/002_automation_defaults_seed.up.sql
scripts/sql/005_automation_weekly_report_monitor_seed.up.sql
```

迁移器按上述依赖顺序执行：事件字段和表先于周报监控任务种子创建。

`001` 合并旧 OA SQL `001、003、004、006、007` 的最终结构，只创建基础 9 张表；`004` 再增加事件触发表 `automation_trigger_events`：

```text
automation_jobs
automation_tags
automation_job_tags
automation_prompt_profiles
automation_job_runs
automation_job_run_projects
automation_ai_interactions
automation_job_change_logs
automation_run_trace_events
automation_trigger_events
```

`002` 只 seed 默认 GitHub 任务、标签和提示词；`005` 预置周报监控任务。它们不写 `auth_permission*`、`projects`、`user` 或 `async_task*`。

完整 `DATABASE_URL` 只放部署平台 Secret，不写入 Git、`.env.example` 或迁移文档。

执行迁移：

```bash
npm run migrate:automation --workspace agent
```

迁移器使用 MySQL advisory lock。为保持基础 schema 的约束，不另建 migration history 表；它只允许基础 9 张表全无或全有，发现半迁移状态会停止。`002` 和 `005` 可重复执行，且只在任务不存在时创建预置任务。

## Runtime

Node 需要以下 Secret：

```dotenv
DATABASE_URL=<由部署平台注入>
OA_SESSION_SECRET=<与原 OA HeaderSessionMiddleware 一致>
OA_AGENT_AUTOMATION_TOKEN=<与 Worker 一致>
```

当前手动触发限流使用进程内滑动窗口，适用于单个 `agent` 实例。MySQL 是任务与运行状态的唯一事实来源；当前部署无需 Redis。扩展为多个 `agent` 副本前，需要将手动限流迁移到共享 Redis 或数据库限流。

`automation maintenance` 由 `AUTOMATION_MAINTENANCE_ENABLED=true` 启动，负责 cron/catch-up/overlap、超时与重试、模型对账和审计保留清理。

## Verification

```bash
npm test --workspace agent
AUTOMATION_NODE_TEST_DATABASE_URL='<专用、以 _automation_test 结尾的 mysql:// URL>' \
  npm run test:automation:integration
npm run test:chat --workspace frontend
npm run test:deploy
```

`test:automation:integration` 会串行执行两组真实 MySQL 测试：并发 claim/maintenance 数据状态机，以及前端 BFF → Node 管理接口 → worker 内部接口的完整 HTTP 工作流。测试库地址必须以 `_automation_test` 结尾。

## Legacy OA Cleanup

旧 OA 仓库仍需在正式切流前处理：

- 将 `scripts/sql/20260805_007_add_automation_no_commits_outcome.up.sql` 纳入正式版本。
- 明确当前被标记删除的 automation down SQL 是否保留；如果旧 OA 迁移已经执行过，生产回滚建议使用新的 forward migration，而不是编辑已部署迁移。
