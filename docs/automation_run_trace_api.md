# 自动任务运行 Trace 接口

## 目标

让自动任务运行详情实时展示 Worker 当前执行阶段、仓库级 Agent 任务、进度、失败或兜底状态。Trace 是可观测旁路，不参与业务幂等、项目状态判断或总结写入；Trace 写入失败不能改变自动任务业务结果。

OAagent 已实现以下调用和展示逻辑，OA 后端需要按本文补齐持久化与两个接口：

- OAagent Worker：`POST /internal/automation-job-runs/{run_id}/trace-events`
- 前端：`GET /automation-job-runs/{run_id}/trace-events`

## 数据模型

建议新增 `automation_run_trace_events` 表，一次运行的同一个 `event_key` 只保留一条最新状态：

| 字段 | 类型建议 | 约束 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `run_id` | uuid/string | 外键，运行删除时级联删除 |
| `event_key` | varchar(200) | 与 `run_id` 组成唯一键 |
| `sequence` | int | 阶段排序，非全局自增 |
| `phase` | varchar(100) | 稳定机器标识 |
| `status` | varchar(32) | `pending/running/succeeded/fallback/failed/cancelled` |
| `title` | varchar(200) | 前端标题 |
| `message` | varchar(1000), nullable | 脱敏进度说明 |
| `progress_current` | int, nullable | 必须大于等于 0 |
| `progress_total` | int, nullable | 必须大于等于 0，且 current 不得大于 total |
| `project_id` | bigint, nullable | 关联 OA 项目 |
| `repository_full_name` | varchar(255), nullable | `owner/repository` |
| `metadata_sanitized` | json | 只允许脱敏统计，不保存 token、Patch、提示词原文 |
| `started_at` | datetime, nullable | 首次进入 `running` 时由 OA 固化 |
| `finished_at` | datetime, nullable | 进入终态时由 OA 固化 |
| `occurred_at` | datetime | Worker 事件时间 |
| `created_at` | datetime | OA 接收时间 |
| `updated_at` | datetime | OA 最后更新时间 |

索引建议：

```text
UNIQUE(run_id, event_key)
INDEX(run_id, sequence, occurred_at, id)
INDEX(run_id, status)
```

Trace 随 `automation_job_runs.retention_days` 清理，不单独延长审计保留周期。

## Worker 写入接口

```http
POST /internal/automation-job-runs/{run_id}/trace-events
Authorization: Bearer <OA_AGENT_AUTOMATION_TOKEN>
Content-Type: application/json
```

请求示例：

```json
{
  "worker_instance": "oaagent-production-01",
  "lease_token": "raw-lease-token",
  "run_id": "7f7dc11f-30b5-482f-a8bf-5ee72b667baf",
  "run_mutation_token": "scoped-hmac-token",
  "fencing_token": 7,
  "idempotency_key": "sha256:64-hex-characters",
  "event_key": "repository_summary:openai/example:2026-08-03",
  "sequence": 510,
  "phase": "repository_summary",
  "status": "running",
  "title": "总结仓库 Commit",
  "message": "openai/example",
  "progress_current": null,
  "progress_total": null,
  "project_id": null,
  "repository_full_name": "openai/example",
  "metadata_sanitized": {
    "commit_count": 8
  },
  "occurred_at": "2026-08-03T12:01:30.000Z"
}
```

后端规则：

1. 复用 claim、heartbeat 和 AI 审计相同的服务鉴权，并在事务内校验 scoped token、当前 lease/fence、deadline 和运行状态。
2. 按 `(run_id, event_key)` 原子 upsert；重试不能生成重复节点。
3. 首次 `running` 时设置 `started_at`，后续更新不得覆盖。
4. `succeeded/fallback/failed/cancelled` 为终态，设置 `finished_at`；同一 key 不允许从终态回退到 `running/pending`。
5. `occurred_at` 允许有限时钟偏差，超出范围时使用 OA 接收时间并记录校正标记。
6. `metadata_sanitized` 限制为 16KB JSON，递归拒绝 `authorization/token/secret/sessionid/patch/system_prompt` 等敏感键。
7. 成功可返回 `204 No Content`，也可返回标准 envelope；OAagent 两种都兼容。
8. 接口不存在或 Trace 写入失败时，OAagent 会停用本次运行的 Trace 上报，但继续执行核心任务。

推荐错误码沿用现有自动化内部接口：`automation_run_not_found`、`invalid_lease_token`、
`lease_expired`、`invalid_run_mutation_token`、`stale_fencing_token`、
`idempotency_conflict`、`run_not_writable`、`automation_trace_invalid`。

## 前端读取接口

```http
GET /automation-job-runs/{run_id}/trace-events
Authorization: Bearer <普通用户 session token>
```

权限建议：

- 普通运行 Trace：`automation:read`；
- 如果未来 Trace 包含更详细的模型或工具内容，再要求 `automation:audit`；
- 当前契约只保存脱敏阶段和统计，普通用户可直接查看。

响应示例：

```json
{
  "code": 200,
  "message": "ok",
  "success": true,
  "data": {
    "total": 3,
    "items": [
      {
        "id": 1,
        "event_key": "load_projects",
        "sequence": 100,
        "phase": "load_projects",
        "status": "succeeded",
        "title": "读取 OA 项目列表",
        "message": "已读取 20 个候选项目",
        "progress_current": 20,
        "progress_total": 20,
        "project_id": null,
        "repository_full_name": null,
        "metadata_sanitized": {},
        "started_at": "2026-08-03T12:00:01.000Z",
        "finished_at": "2026-08-03T12:00:02.000Z",
        "occurred_at": "2026-08-03T12:00:02.000Z",
        "updated_at": "2026-08-03T12:00:02.100Z"
      }
    ]
  }
}
```

必须按 `sequence ASC, occurred_at ASC, id ASC` 返回。首期不需要分页参数，但必须返回 `{total, items}` 结构；建议限制单次最多 1000 条。

## OAagent 已上报的阶段

| sequence | event_key/phase | 内容 |
| ---: | --- | --- |
| 10 | `worker_claimed` | Worker 已领取任务 |
| 20 | `validate_configuration` | 校验任务类型、模型、时区和提示词能力 |
| 100 | `load_projects` | 读取 OA 项目列表 |
| 200 | `discover_repositories` | 过滤归档项目、解析并去重仓库 |
| 300 | `read_github` | 读取分支、Commit 和最后活动时间 |
| 400 | `prepare_repository_tasks` | 只为当天有 Commit 的仓库生成任务 |
| 500 | `summarize_repositories` | 仓库任务总体进度 |
| 510 | `repository_summary:*` | 单仓库 Codex Thread 状态 |
| 600 | `persist_projects` | 聚合项目总结并写入状态/总结 |
| 700 | `upload_run_audit` | 写入项目运行结果和 AI interaction |
| 900 | `finalize_run` | 成功、部分失败、失败或取消终态 |

同一仓库节点会按 `running -> succeeded/fallback/failed/cancelled` 更新，前端每 3 秒查询活动运行；运行进入终态后自动停止轮询。

## 发布顺序

1. OA 后端执行数据库迁移并发布两个 Trace 接口。
2. 更新 OA OpenAPI 文档和接口测试。
3. 发布当前 OAagent Worker 与前端。
4. 重启 `project-progress-worker`，手动触发一次测试任务。
5. 在运行详情确认阶段实时变化、仓库节点数量正确、终态后停止请求。

若先发布 OAagent，旧 OA 后端会返回 404；Worker 会自动关闭本次 Trace 上报，核心任务不受影响，前端显示“OA 后端尚未启用运行 Trace 接口”。
