# OA 指定项目 Commit 总结接口

本文只描述 OA 服务端接入时需要依赖的最小响应字段。接口可能返回额外的调度、模型或审计字段，OA 应忽略并且不要依赖这些未列出的字段。

## 1. 地址与鉴权

OA 页面通过 BFF 转发请求，不直接调用 Node 原始路由：

```text
OA 页面或 OA 服务 -> /api/automation/* -> Node /automation-*
```

BFF 转发用户的 `sessionid` Cookie。Node 使用与原 OA 相同的 `OA_SESSION_SECRET` 验证 Cookie 并取得 `user_id`。

```http
Cookie: sessionid=<OA 登录会话>
Content-Type: application/json
```

对外 Base URL：

```text
https://oa-agent.rwkvos.com
```

## 2. 通用响应结构

所有接口都使用以下响应外壳：

```json
{
  "code": 200,
  "message": "success",
  "data": {},
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | integer | 业务状态码，通常与 HTTP 状态码一致。业务判断应优先同时检查 HTTP 状态和 `success`。 |
| `message` | string | 面向人的结果或错误说明，可展示，不应作为程序分支条件。 |
| `data` | object / null | 业务数据。失败时通常为 `null`，部分错误会返回结构化错误信息。 |
| `success` | boolean | `true` 表示请求成功；`false` 表示请求未完成。 |

时间字段均为 ISO 8601 字符串，例如 `2026-08-14T08:30:00.000Z`；`null` 表示该事件尚未发生。

## 3. 获取 job_id

`job_id` 不是固定常量。OA 应按 `job_key` 查询，不要把数据库主键写死在代码中。

```http
GET /api/automation/jobs?job_type=github_project_progress_sync&enabled=true&configuration_status=valid&page=1&size=20
```

最小响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1,
    "items": [
      {
        "id": 1,
        "job_key": "github-project-progress-sync",
        "name": "GitHub 项目进度总结",
        "enabled": true,
        "configuration_status": "valid"
      }
    ]
  },
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.total` | integer | 满足查询条件的任务数量。 |
| `data.items` | array | 任务列表。OA 通常选择 `job_key=github-project-progress-sync` 的一项。 |
| `data.items[].id` | integer | 任务主键，即后续接口中的 `job_id`。 |
| `data.items[].job_key` | string | 稳定的任务业务标识，适合代码匹配。 |
| `data.items[].name` | string | 任务显示名称。 |
| `data.items[].enabled` | boolean | 是否允许触发任务。只有 `true` 时才能正常创建运行。 |
| `data.items[].configuration_status` | string | 配置状态：`valid` 可运行，`unverified` 未验证，`invalid` 配置无效。本查询通常只返回 `valid`。 |

## 4. 创建指定项目运行

```http
POST /api/automation/jobs/{job_id}/runs
```

请求体：

```json
{
  "project_id": 123,
  "summary_scope": "today"
}
```

| 请求字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `project_id` | integer | 是 | OA 项目 ID，只处理该项目。 |
| `summary_scope` | string | 否 | 总结范围。建议显式传值；省略时继承任务配置，任务未配置时才使用 `today`。 |

`summary_scope` 枚举：

| 值 | 说明 |
| --- | --- |
| `today` | 汇总项目各仓库当天的 Commit。 |
| `latest_commit_of_updating_projects` | 仅允许状态为 `updating` 的项目，跨全部仓库选择整个项目最新的一条 Commit，不限制日期。 |

指定项目不是 `updating` 时，第二种范围不会处理该项目，运行可正常结束但 `projects` 为空。

最小成功响应：

```json
{
  "code": 202,
  "message": "accepted",
  "data": {
    "run_id": "a4af411e-4a72-49a2-82fe-8e7198ca15f0",
    "status": "pending",
    "reused": false
  },
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.run_id` | string(UUID) | 本次运行 ID。用于查询详情、Trace 和取消运行。 |
| `data.status` | string | 当前运行状态，枚举见“运行状态”。创建后通常为 `pending`。 |
| `data.reused` | boolean | `false` 表示创建了新运行；`true` 表示相同项目已有活动运行，本次直接返回已有 `run_id`。 |

同一项目且 `summary_scope` 相同时，并发调用会复用 `pending`、`claimed` 或 `running` 的已有运行。范围不同的调用可以分别入队，但 Worker 的 overlap 规则不会让它们同时处理同一项目。

## 5. 查询项目活动运行

在创建前或页面刷新时查询指定项目是否已有运行：

```http
GET /api/automation/runs?job_id=1&project_id=123&active_only=true&include_full_scope=true&page=1&size=20
```

`job_id` 和 `project_id` 同时传入时按交集过滤。本流程应传入已按
`job_key` 获取的 `job_id`，避免把同一项目下其他自动任务的活动运行误判为当前任务。
通用运行列表查询仍可省略 `job_id`，以保留跨任务查询能力。

| 查询参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `job_id` | integer | 否 | 自动任务 ID。通用运行列表可省略；查询指定任务的项目活动运行时建议传入。 |
| `project_id` | integer | 是 | OA 项目 ID。 |
| `active_only` | boolean | 否 | `true` 时只返回 `pending`、`claimed`、`running`。 |
| `include_full_scope` | boolean | 否 | `true` 时也返回同一任务下可能处理该项目的全量运行。建议传 `true`。 |
| `page` | integer | 否 | 页码，从 1 开始。 |
| `size` | integer | 否 | 每页数量。 |

最小响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1,
    "items": [
      {
        "id": "a4af411e-4a72-49a2-82fe-8e7198ca15f0",
        "job_id": 1,
        "status": "running",
        "trigger_source": "manual",
        "execution_parameters": {
          "project_id": 123,
          "summary_scope": "today"
        },
        "attempt": 1,
        "started_at": "2026-08-14T08:30:00.000Z",
        "deadline_at": "2026-08-14T09:00:00.000Z",
        "cancel_requested_at": null,
        "error_code": null,
        "error_summary": null
      }
    ]
  },
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.total` | integer | 满足过滤条件的运行数量。`0` 表示当前没有活动运行。 |
| `data.items` | array | 活动运行列表。 |
| `data.items[].id` | string(UUID) | 运行 ID，等同于创建接口的 `run_id`。 |
| `data.items[].job_id` | integer | 产生该运行的任务 ID。 |
| `data.items[].status` | string | 当前状态，枚举见“运行状态”。 |
| `data.items[].trigger_source` | string | 触发来源：`manual`、`schedule`、`catch_up` 或 `retry`。 |
| `data.items[].execution_parameters` | object | 本次运行的执行范围快照。重试会继承它。 |
| `data.items[].execution_parameters.project_id` | integer / null | 指定项目 ID；为空或不存在表示全量运行。 |
| `data.items[].execution_parameters.summary_scope` | string / omitted | 显式传入的总结范围；省略时 Worker 按任务配置解析实际范围。 |
| `data.items[].attempt` | integer | 当前重试次数，首次执行为 1。 |
| `data.items[].started_at` | string / null | Worker 实际开始执行时间。 |
| `data.items[].deadline_at` | string / null | 本次运行最晚允许完成的时间。 |
| `data.items[].cancel_requested_at` | string / null | 非空表示已请求取消，但 Worker 可能仍在收尾。 |
| `data.items[].error_code` | string / null | 失败后的稳定错误码；运行中通常为空。 |
| `data.items[].error_summary` | string / null | 已脱敏的错误摘要，可直接展示。 |

## 6. 查询结果

OA 获取业务结果时只需要展开 `projects`：

```http
GET /api/automation/runs/{run_id}?include=projects
```

不要默认请求 `ai_interactions` 和 `attempts`。它们只用于审计或排障，会显著增加响应体。

最小响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": "a4af411e-4a72-49a2-82fe-8e7198ca15f0",
    "status": "succeeded",
    "execution_parameters": {
      "project_id": 123,
      "summary_scope": "today"
    },
    "attempt": 1,
    "projects_total": 1,
    "projects_succeeded": 1,
    "projects_failed": 0,
    "mutations_applied": true,
    "retry_recommended": false,
    "error_code": null,
    "error_summary": null,
    "cancel_requested_at": null,
    "started_at": "2026-08-14T08:30:00.000Z",
    "finished_at": "2026-08-14T08:31:18.000Z",
    "duration_ms": 78000,
    "projects": [
      {
        "project_id": 123,
        "project_name": "OAagent-codex",
        "outcome": "evaluated",
        "repository_count": 2,
        "commit_count": 5,
        "summary_date": "2026-08-14",
        "generated_summary": "今日完成了自动任务接口与运行查询能力。",
        "ai_confidence": 93,
        "ai_note": null,
        "warnings": [],
        "mutations_applied": true
      }
    ]
  },
  "success": true
}
```

### 6.1 运行详情示例与字段说明

`data` 中的字段分为运行级状态和项目级结果两部分。运行尚未结束时，计数和
`projects` 可能仍在变化；调用方应先根据 `data.status` 判断是否进入终态，再读取最终结果。

运行级字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.id` | string(UUID) | 运行 ID。 |
| `data.status` | string | 运行状态。只有终态时才能确定最终结果。 |
| `data.execution_parameters` | object | 本次实际执行范围，字段含义同活动运行接口。 |
| `data.execution_parameters.project_id` | integer / null | 指定项目 ID；为空或不存在表示本次运行按任务范围处理项目。 |
| `data.execution_parameters.summary_scope` | string / omitted | 本次运行显式使用的总结范围；省略时由任务配置解析实际范围。 |
| `data.attempt` | integer | 当前是第几次尝试。 |
| `data.projects_total` | integer | 本次纳入处理的项目数。 |
| `data.projects_succeeded` | integer | 成功完成处理的项目数，包括正常的“无 Commit”结果。 |
| `data.projects_failed` | integer | 处理失败或结果不完整的项目数。 |
| `data.mutations_applied` | boolean | 是否至少成功向 OA 写入过一次业务数据。 |
| `data.retry_recommended` | boolean | 服务端是否建议重试。调用方不应自行立即重试，应等待自动重试或明确由用户再次触发。 |
| `data.error_code` | string / null | 运行级错误码。成功时为空。 |
| `data.error_summary` | string / null | 运行级脱敏错误摘要。 |
| `data.cancel_requested_at` | string / null | 取消请求时间；非空不等同于已经取消，应继续观察 `status`。 |
| `data.started_at` | string / null | 开始执行时间。 |
| `data.finished_at` | string / null | 进入终态的时间。 |
| `data.duration_ms` | integer / null | 执行耗时，单位毫秒。 |
| `data.projects` | array | 项目结果列表。指定项目运行通常只有一项。 |

项目结果字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.projects[].project_id` | integer | OA 项目 ID。 |
| `data.projects[].project_name` | string | OA 项目名称快照。 |
| `data.projects[].outcome` | string | 项目处理结果，枚举见“项目结果”。 |
| `data.projects[].repository_count` | integer | 本次成功解析并参与处理的仓库数量。 |
| `data.projects[].commit_count` | integer | 本次纳入总结的 Commit 数量。 |
| `data.projects[].summary_date` | string / null | 总结归属日期，格式为 `YYYY-MM-DD`。无可总结内容时可能为空。 |
| `data.projects[].generated_summary` | string / null | AI 生成的最终总结。失败或无 Commit 时为空。 |
| `data.projects[].ai_confidence` | integer / null | AI 输出的置信度，范围为 0 到 100；未生成总结时为空。 |
| `data.projects[].ai_note` | string / null | AI 对总结完整性或限制的简短说明。 |
| `data.projects[].warnings` | array | 已脱敏的非致命告警列表；为空表示没有告警。告警内容只用于展示，不应解析内部键。 |
| `data.projects[].warnings[].code` | string | 告警代码和简短上下文，已截断和脱敏。 |
| `data.projects[].mutations_applied` | boolean | 该项目的总结是否已经写回 OA。 |

## 7. 查询 Trace

```http
GET /api/automation/runs/{run_id}/trace-events
```

最小响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 2,
    "items": [
      {
        "phase": "github",
        "status": "running",
        "title": "读取 GitHub Commit",
        "message": "正在读取 rwkv/oaagent-codex",
        "progress_current": 1,
        "progress_total": 2,
        "project_id": 123,
        "repository_full_name": "rwkv/oaagent-codex"
      }
    ]
  },
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.total` | integer | 当前已记录的 Trace 事件总数。 |
| `data.items` | array | 按执行顺序返回的 Trace 事件。 |
| `data.items[].phase` | string | 执行阶段标识，例如 `load_projects`、`read_github_repository`、`repository_summary`、`persist_projects`。 |
| `data.items[].status` | string | 当前事件状态，例如 `pending`、`running`、`succeeded`、`failed`。 |
| `data.items[].title` | string | 简短阶段标题，适合直接展示。 |
| `data.items[].message` | string / null | 已脱敏的进度或错误说明。 |
| `data.items[].progress_current` | integer / null | 当前完成数量；无法量化时为空。 |
| `data.items[].progress_total` | integer / null | 总数量；无法量化时为空。 |
| `data.items[].project_id` | integer / null | 当前事件关联的 OA 项目 ID。 |
| `data.items[].repository_full_name` | string / null | 当前事件关联的 GitHub 仓库，格式为 `owner/repository`。 |

## 8. 取消运行

```http
POST /api/automation/runs/{run_id}/cancel
```

无需请求体。最小响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": "a4af411e-4a72-49a2-82fe-8e7198ca15f0",
    "status": "running",
    "cancel_requested_at": "2026-08-14T08:30:40.000Z"
  },
  "success": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.id` | string(UUID) | 被取消的运行 ID。 |
| `data.status` | string | 接口返回时的状态。`pending` 运行可立即变成 `cancelled`；正在执行的运行可能暂时仍为 `running`。 |
| `data.cancel_requested_at` | string | 取消请求被接受的时间。OA 应继续轮询，直到状态变为终态。 |

取消是协作式的。Worker 会在安全检查点停止，不会强行中断正在进行的单次外部请求。

## 9. 运行状态

| 状态 | 是否终态 | 说明 |
| --- | --- | --- |
| `pending` | 否 | 已进入队列，等待 Worker。 |
| `claimed` | 否 | 已被 Worker 领取，准备执行。 |
| `running` | 否 | 正在读取 OA/GitHub、调用 AI 或写回结果。 |
| `succeeded` | 是 | 运行成功。没有符合范围的 Commit 也可以正常成功。 |
| `partial_failed` | 是 | 部分项目成功、部分项目失败。 |
| `failed` | 是 | 运行失败，查看 `error_code` 和 `error_summary`。执行超时也记录为此状态，并使用 `job_timeout` 错误码。 |
| `configuration_error` | 是 | Worker、模型或提示词配置错误。 |
| `skipped` | 是 | 因调度宽限等规则跳过。 |
| `cancelled` | 是 | 已取消。 |

## 10. 项目结果

| `outcome` | 成功 | 说明 |
| --- | --- | --- |
| `evaluated` | 是 | 项目已正常评估，并生成、覆盖或复用总结。是否实际写入看 `mutations_applied`。 |
| `archived` | 是 | 项目已归档，不读取 GitHub。 |
| `no_github_urls` | 是 | 项目没有配置 GitHub 仓库。 |
| `no_commits` | 是 | 指定范围内没有 Commit，不调用 AI，也不写空总结。 |
| `invalid_github_urls` | 否 | GitHub URL 格式无效。此类错误不自动重试。 |
| `incomplete` | 否 | 仓库读取或证据不完整，未写入不完整总结。仓库 404 等错误通常归入此项。 |
| `write_conflict` | 否 | OA 数据已被其他操作修改，写入保护阻止覆盖。 |
| `failed` | 否 | AI 总结、写回或其他项目处理步骤失败。是否自动重试看运行的 `retry_recommended`。 |

## 11. 错误响应

```json
{
  "code": 409,
  "message": "任务未启用",
  "data": {
    "error_code": "job_disabled",
    "details": null
  },
  "success": false
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.error_code` | string | 稳定错误码，程序应使用它做分支判断。 |
| `data.details` | object / array / null | 可选错误上下文。字段校验失败时是问题数组，其他错误通常为空。 |
| `data.details[].path` | array | 字段校验失败时的问题字段路径。 |
| `data.details[].message` | string | 字段校验失败时的具体原因。 |

常见 HTTP 状态：

| HTTP | 说明 |
| --- | --- |
| `400` | 请求字段或枚举值错误。 |
| `401` | 缺少 `sessionid` 或会话验签失败。 |
| `403` | 用户已登录但没有自动任务权限。 |
| `404` | `job_id` 或 `run_id` 不存在。项目不存在是在异步运行中体现为失败。 |
| `409` | 任务未启用、任务配置无效，或当前运行状态不允许操作。 |
| `429` | 手动触发频率超过限制。 |
| `500` | Node 内部错误。 |
| `502` | OA、GitHub、模型服务等上游调用失败。 |
| `503` | Redis、数据库或 Worker 暂时不可用。 |

## 12. OA 推荐调用流程

1. OA 启动时按 `job_key` 获取并缓存 `job_id`。
2. 页面进入项目时携带 `job_id` 和 `project_id` 查询该任务的活动运行。
3. 没有活动运行时调用创建接口；有活动运行时直接复用它的 `id`。
4. 每 2 至 5 秒查询运行详情；需要进度时同时查询 Trace。
5. 进入终态后读取 `projects[0].outcome` 和 `generated_summary`。
6. 用户取消后继续轮询，直到状态进入“运行状态”表中的任一终态。
