# 自动化任务与执行审计 API

OAagent 开发和联调请优先阅读 [OAagent 与 OA 自动化联调 API](oaagent_integration_api.md)，其中包含双向模型接口、Worker payload、项目同步 payload、cURL、状态机和错误处理约定。

## 边界

OA 保存任务、标签、cron、模型标识、运行快照和审计，负责 claim、租约、状态机、重试和保留。OAagent 是模型目录唯一来源，并负责 GitHub、模型调用和业务写入。OA 不保存 GitHub token、模型 API Key、OAagent 模型地址或服务请求头。

## 权限和服务认证

- `automation:read`：任务、标签和普通运行信息
- `automation:write`：创建、修改、启停、校验和取消
- `automation:trigger`：手动触发
- `automation:audit`：项目详情和完整 AI 审计
- `automation:admin`：标签与高级管理，并覆盖其他自动化权限
- 现有 `admin` 权限同样覆盖自动化细分权限
- Worker API：`Authorization: Bearer <OA_AGENT_AUTOMATION_TOKEN>`
- 项目同步 API：`Authorization: Bearer <OA_PROJECT_SYNC_TOKEN>`

两个服务 token 独立且不可互换。浏览器接口继续使用原 session。

## 管理 API

| Method | Path | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/automation-models` | `automation:read` | OAagent 模型目录代理；返回 `cached_at` 和 `stale` |
| GET/POST | `/automation-tags` | read/admin | 分页查询或创建标签 |
| PATCH/DELETE | `/automation-tags/{tag_id}` | admin | 修改；仅未引用标签可删除 |
| GET/POST | `/automation-jobs` | read/write | 分页查询或创建任务；`include_deleted=true` 可包含已删除任务 |
| GET/PATCH | `/automation-jobs/{job_id}` | read/write | 详情和带 `version` 的乐观锁修改；详情可传 `include_deleted=true` |
| DELETE | `/automation-jobs/{job_id}?version={version}` | write | 软删除；有未结束运行时返回 409 |
| POST | `/automation-jobs/{job_id}/validate` | write | 实时校验 OAagent 模型配置 |
| POST | `/automation-jobs/{job_id}/runs` | trigger | 手动触发，返回 202 |
| GET | `/automation-job-runs` | read | 分页、状态、模型、标签和时间过滤 |
| GET | `/automation-job-runs/{run_id}` | read/audit | `include=projects,ai_interactions,attempts` |
| GET | `/automation-job-runs/{run_id}/trace-events` | read | 查询脱敏运行阶段与实时进度 |
| POST | `/automation-job-runs/{run_id}/cancel` | write | pending 直接取消；claimed/running 发出取消请求 |

错误保持统一 envelope：

```json
{
  "code": 409,
  "message": "任务版本冲突",
  "data": {
    "error_code": "automation_job_version_conflict",
    "details": null
  },
  "success": false
}
```

任务删除不是物理删除。成功删除会设置 `enabled=false`、`next_run_at=null`、`deleted_at`、`deleted_by` 并递增 `version`。任务行、`job_key` 唯一约束和历史外键继续保留，因此不能用相同 `job_key` 新建任务。普通任务列表默认隐藏已删除任务；运行列表和详情通过 `job_deleted=true`、`job_display_name="原名称（已删除）"` 展示关联任务状态。`pending`、`claimed` 或 `running` 运行存在时返回 `409 job_has_active_run`，应先取消并等待运行进入终态。

## Worker API

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/internal/automation-job-runs/claim` | 原子 claim；无任务返回 204 |
| POST | `/internal/automation-job-runs/{run_id}/heartbeat` | 续租，延长时间不超过 deadline |
| PATCH | `/internal/automation-job-runs/{run_id}` | running 或终态回传；时间和计数由 OA 生成 |
| PUT | `/internal/automation-job-runs/{run_id}/projects/{project_id}` | 按 `(run_id, project_id)` 幂等写项目结果 |
| POST | `/internal/automation-job-runs/{run_id}/ai-interactions` | 按 `(run_id, interaction_key)` 幂等写脱敏 AI 审计 |
| POST | `/internal/automation-job-runs/{run_id}/trace-events` | 按 `(run_id, event_key)` 幂等更新脱敏运行阶段 |

推荐 `lease_seconds=300`，Worker 每约 60 秒 heartbeat。数据库只保存租约摘要；raw lease token 只在 claim 响应返回一次。所有后续写入同时校验 worker、摘要、租约过期时间、deadline 和运行状态。

claim 优先级：deadline 超时处理 → 过期租约接管 → pending manual/retry → 到期 cron。到期任务使用 MySQL 8 `FOR UPDATE SKIP LOCKED`，同一事务内创建运行、写租约并推进 `next_run_at`。

## 项目同步 API

`OA_PROJECT_SYNC_TOKEN` 只能访问：

- `GET /internal/project-sync/projects`
- `GET /internal/project-sync/projects/{project_id}`
- `PATCH /internal/project-sync/projects/{project_id}/status`
- `GET/POST /internal/project-sync/github-commit-summaries`
- `GET/PATCH /internal/project-sync/github-commit-summaries/{summary_id}`

该 router 不提供 DELETE、项目任意字段更新或其他项目资源。

## 时间、重试和保留

- 自动化时间以 UTC naive `DATETIME(6)` 保存，API 以 UTC ISO 8601 返回
- disabled 任务 `next_run_at=NULL`
- `scheduled_at` 是逻辑计划时间；重试保持根运行的 `scheduled_at`
- `available_at` 控制 retry 延迟；`deadline_at` 控制总执行超时
- `retry_max_attempts` 是包含第一次在内的总尝试数
- configuration error 不重试；重试继承根运行的任务、标签、模型和调度快照
- `latest` 只补最近一次，`skip` 创建 skipped 审计后推进计划
- 终态运行不可修改，仅允许内容一致的幂等回放
- 保留清理只处理终态运行：清空大 prompt/request/response，保留模型、token 计数、延迟、状态、错误和最终总结，并写 `purged_at`

## 配置

```dotenv
OA_AGENT_INTERNAL_BASE_URL=http://127.0.0.1:3001
OA_AGENT_AUTOMATION_TOKEN=replace-with-dedicated-service-token
OA_PROJECT_SYNC_TOKEN=replace-with-dedicated-project-sync-token
AUTOMATION_MODEL_CATALOG_TTL_SECONDS=300
AUTOMATION_MODEL_CATALOG_STALE_SECONDS=86400
AUTOMATION_SCHEDULE_GRACE_SECONDS=120
AUTOMATION_MANUAL_TRIGGER_LIMIT=3
AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS=300
AUTOMATION_MAINTENANCE_ENABLED=true
```

模型目录读缓存 fresh TTL 为 5 分钟；OAagent 不可用时最多回退 24 小时 stale 缓存。创建、修改、启用、手动触发和显式校验始终实时调用 OAagent。

## 数据库迁移与回滚

按顺序执行：

```bash
mysql < scripts/sql/20260730_001_create_automation_schema.up.sql
mysql < scripts/sql/20260730_002_seed_automation_defaults.up.sql
mysql < scripts/sql/20260731_003_add_automation_job_soft_delete.up.sql
```

默认任务 `github-project-progress-sync` 保持 `enabled=false`、`configuration_status=unverified`、`next_run_at=NULL`。确认 OAagent、GitHub token、OA 项目同步 token 和每分钟分发器均可用后，通过校验接口再启用。

回滚顺序相反：

```bash
mysql < scripts/sql/20260731_003_add_automation_job_soft_delete.down.sql
mysql < scripts/sql/20260730_002_seed_automation_defaults.down.sql
mysql < scripts/sql/20260730_001_create_automation_schema.down.sql
```

软删除 down 脚本会丢失任务的删除标记，生产环境应优先使用新的前向修复迁移，不建议直接回滚。

迁移不读取、不转换也不删除现有 `async_task` 或项目 commit summary 数据。

## 验证

```bash
python -m pytest tests/automation -q
python -m compileall fast
```

真实事务并发 claim 测试只接受显式专用库，且数据库名必须以 `_automation_test` 结尾：

```bash
AUTOMATION_TEST_DATABASE_URL='mysql+asyncmy://.../oa_automation_test' \
  python -m pytest tests/automation/test_mysql_claim_concurrency.py -q
```

该测试会在专用库内创建并清理七张 automation 表；不要指向开发、测试共享库或生产库。
