# OA 指定项目 Commit 总结接口

## 1. 接口用途

OA 页面通过已有自动任务手动发起一次项目 Commit 总结。调用方可以：

- 按任务原配置处理全部项目；
- 只处理一个指定 OA 项目；
- 总结当天 Commit；
- 总结更新中项目不限日期的最新一条 Commit。

该接口只创建异步运行，成功响应中的 `run_id` 用于查询进度、结果、Trace 和取消运行。GitHub Token 和模型密钥始终由 Worker 服务端持有，OA 页面不得上传这些密钥。

## 2. 地址与鉴权

### 2.1 OA 页面调用地址

```http
POST /api/automation/jobs/{job_id}/runs
```

OA 页面使用同域登录 Cookie：

```http
Cookie: sessionid=<OA_SESSION>
```

浏览器使用 `credentials: "same-origin"` 时会自动携带 Cookie，不需要读取或手动拼接 HttpOnly `sessionid`。

### 2.2 Node 服务原始地址

```http
POST /automation-jobs/{job_id}/runs
```

前端 BFF 会把 OA `sessionid` 转发给 Node。业务页面应优先调用 `/api/automation/*`，不要绕过 BFF，也不要使用 `OA_AGENT_AUTOMATION_TOKEN` 或 `OA_PROJECT_SYNC_TOKEN`。

### 2.3 Session 校验

Node 使用与原 OA 相同的 `OA_SESSION_SECRET` 验证 `sessionid` 签名并提取 `user_id`。登录态缺失、签名错误或过期时返回 HTTP `401`。

## 3. 创建手动运行

```http
POST /api/automation/jobs/{job_id}/runs
Content-Type: application/json
```

### 3.1 路径参数

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `job_id` | integer | 是 | 正整数 | 已存在且未删除的自动任务 ID |

### 3.2 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `project_id` | integer | 否 | 正整数 | 本次只处理该 OA 项目 |
| `summary_scope` | enum | 否 | 见下方枚举 | 覆盖本次运行的总结范围，不修改任务配置 |

请求体必须是 JSON object，不允许额外字段。

### 3.3 `summary_scope` 枚举

| 枚举值 | 说明 |
| --- | --- |
| `today` | 按本次运行时间对应的北京时间处理当天 Commit |
| `latest_commit_of_updating_projects` | 只处理 `updating` 项目，从项目所有仓库中选择时间最新的一条 Commit，不限制日期 |

`today` 模式下，多仓库项目会聚合各仓库当天的 Commit。当天没有 Commit 时项目结果为 `no_commits`，不调用模型伪造总结。

`latest_commit_of_updating_projects` 模式下：

- 非 `updating` 项目不进入候选集；
- 多仓库只选择整个项目时间最新的一条 Commit；
- 项目没有任何 Commit 时结果为 `no_commits`。

### 3.4 默认行为

| 请求体 | 实际行为 |
| --- | --- |
| 空 body | 处理任务原范围内的全部项目，使用任务保存的 `model_parameters.summary_scope` |
| `{}` | 与空 body 相同 |
| `{"project_id": 51}` | 只处理项目 51，并默认使用 `today` |
| `{"summary_scope": "today"}` | 全部项目临时使用 `today` |
| `{"project_id": 51, "summary_scope": "today"}` | 只总结项目 51 的当天动态 |

旧任务没有 `model_parameters.summary_scope` 时按 `today` 执行。

### 3.5 请求示例

只总结项目 51 的当天动态：

```json
{
  "project_id": 51,
  "summary_scope": "today"
}
```

只总结项目 51 不限日期的最新 Commit：

```json
{
  "project_id": 51,
  "summary_scope": "latest_commit_of_updating_projects"
}
```

沿用任务原配置执行全部项目：

```json
{}
```

### 3.6 TypeScript 示例

使用项目封装：

```ts
import { triggerAutomationJob } from "@/lib/automation-api"

const run = await triggerAutomationJob(7, {
  project_id: 51,
  summary_scope: "today",
})

console.log(run.run_id, run.status)
```

直接使用 `fetch`：

```ts
const response = await fetch("/api/automation/jobs/7/runs", {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project_id: 51,
    summary_scope: "today",
  }),
})

const payload = await response.json()
if (!response.ok || payload.success !== true) {
  throw new Error(payload.message || "创建自动任务运行失败")
}
```

### 3.7 成功响应

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
```

```json
{
  "code": 202,
  "message": "accepted",
  "data": {
    "run_id": "7f7dc11f-30b5-482f-a8bf-5ee72b667baf",
    "status": "pending"
  },
  "success": true
}
```

HTTP `202` 只表示运行记录创建成功，不表示 GitHub 读取或 AI 总结已经完成。

## 4. 查询运行详情

OA 页面地址：

```http
GET /api/automation/runs/{run_id}?include=projects,ai_interactions,attempts
```

Node 原始地址：

```http
GET /automation-job-runs/{run_id}?include=projects,ai_interactions,attempts
```

### 4.1 `include` 枚举

多个值使用英文逗号分隔：

| 枚举值 | 说明 |
| --- | --- |
| `projects` | 返回项目执行结果 |
| `ai_interactions` | 返回脱敏 AI 调用审计 |
| `attempts` | 返回根运行的全部重试记录 |

不支持的值返回 HTTP `422 invalid_include`。

### 4.2 运行详情示例

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": "7f7dc11f-30b5-482f-a8bf-5ee72b667baf",
    "root_run_id": "7f7dc11f-30b5-482f-a8bf-5ee72b667baf",
    "parent_run_id": null,
    "job_id": 7,
    "job_type": "github_project_progress_sync",
    "trigger_source": "manual",
    "status": "running",
    "attempt": 1,
    "execution_parameters": {
      "project_id": 51,
      "summary_scope": "today"
    },
    "projects_total": 1,
    "projects_succeeded": 0,
    "projects_failed": 0,
    "mutations_applied": false,
    "retry_recommended": false,
    "error_code": null,
    "error_summary": null,
    "cancel_requested_at": null,
    "projects": [],
    "ai_interactions": [],
    "attempts": []
  },
  "success": true
}
```

`execution_parameters` 是本次运行快照。任务后续修改不会改变该值；自动重试也会继承相同的 `project_id` 和 `summary_scope`。

## 5. 运行状态枚举

| 状态 | 是否终态 | 说明 |
| --- | --- | --- |
| `pending` | 否 | 已创建，等待 Worker 领取 |
| `claimed` | 否 | Worker 已领取并持有租约 |
| `running` | 否 | 正在读取 OA、GitHub、调用模型或写入结果 |
| `succeeded` | 是 | 运行成功；没有符合范围的 Commit 也可以正常成功 |
| `partial_failed` | 是 | 部分项目成功，部分项目失败 |
| `failed` | 是 | 本次运行失败 |
| `configuration_error` | 是 | Worker、模型或提示词配置错误 |
| `skipped` | 是 | 因调度宽限、重叠等规则跳过 |
| `cancelled` | 是 | 运行已取消 |

页面应仅在 `pending`、`claimed`、`running` 状态下继续轮询。

## 6. 项目结果枚举

查询详情并包含 `projects` 时，每个项目的 `outcome` 可能为：

| 枚举值 | 说明 |
| --- | --- |
| `evaluated` | 项目已正常评估并生成或复用总结 |
| `archived` | 项目已归档，不读取 GitHub |
| `no_github_urls` | 项目没有 GitHub 仓库配置 |
| `no_commits` | 选定范围内没有 Commit |
| `invalid_github_urls` | GitHub URL 格式无效 |
| `incomplete` | 仓库读取或证据不完整，未写入不完整结果 |
| `write_conflict` | OA 数据已被其他操作修改，写入冲突 |
| `failed` | 项目处理失败 |

项目结果主要字段：

```json
{
  "project_id": 51,
  "project_name": "OAagent-codex",
  "outcome": "evaluated",
  "repository_count": 1,
  "commit_count": 3,
  "summary_date": "2026-08-13",
  "generated_summary": "完成自动任务单项目触发能力。",
  "ai_confidence": 92,
  "ai_note": "基于 3 条提交。",
  "warnings": [],
  "mutations_applied": true
}
```

## 7. 查询 Trace

OA 页面地址：

```http
GET /api/automation/runs/{run_id}/trace-events
```

Node 原始地址：

```http
GET /automation-job-runs/{run_id}/trace-events
```

响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "total": 1,
    "items": [
      {
        "event_key": "load_projects",
        "sequence": 100,
        "phase": "load_projects",
        "status": "succeeded",
        "title": "读取 OA 项目列表",
        "message": "已读取 1 个候选项目",
        "progress_current": 1,
        "progress_total": 1,
        "project_id": null,
        "repository_full_name": null,
        "metadata_sanitized": {
          "project_id": 51,
          "summary_scope": "today"
        }
      }
    ]
  },
  "success": true
}
```

Trace 状态枚举：

```text
pending
running
succeeded
fallback
failed
cancelled
```

## 8. 取消运行

OA 页面地址：

```http
POST /api/automation/runs/{run_id}/cancel
```

Node 原始地址：

```http
POST /automation-job-runs/{run_id}/cancel
```

取消接口不需要请求体：

```ts
await fetch(`/api/automation/runs/${encodeURIComponent(runId)}/cancel`, {
  method: "POST",
  credentials: "same-origin",
})
```

取消行为：

- `pending`：立即转为 `cancelled`；
- `claimed`、`running`：写入取消请求，Worker 在安全检查点停止；
- 已进入终态：返回 HTTP `409 invalid_run_transition`。

## 9. 错误响应

统一结构：

```json
{
  "code": 409,
  "message": "任务已有未结束运行",
  "data": {
    "error_code": "job_already_running",
    "details": null
  },
  "success": false
}
```

### 9.1 创建运行常见错误

| HTTP | `data.error_code` | 说明 |
| --- | --- | --- |
| `400` | `invalid_request` | 请求体不是 JSON object |
| `401` | `unauthorized` | OA 登录态缺失、无效或验签失败 |
| `404` | `automation_job_not_found` | 自动任务不存在或已软删除 |
| `409` | `job_disabled` | 自动任务未启用 |
| `409` | `job_configuration_invalid` | 任务模型配置无效 |
| `409` | `job_already_running` | 同一任务已有 `pending`、`claimed` 或 `running` 运行 |
| `413` | `request_too_large` | 请求体超过限制 |
| `415` | `invalid_request` | 非空 body 未使用 `application/json` |
| `422` | 校验消息 | `project_id`、`summary_scope` 或额外字段校验失败 |
| `429` | `rate_limit_exceeded` | 当前用户对该任务手动触发过于频繁 |
| `500` | - | 自动任务服务内部错误 |

字段校验错误的 `error_code` 当前取第一条校验消息，调用方不要把该文案视为长期稳定枚举；应以 HTTP `422`、`success=false` 和 `details` 判断。

### 9.2 异步运行错误

接口返回 `202` 后仍可能在 Worker 阶段失败。调用方需要查询运行详情中的：

```text
status
error_code
error_summary
retry_recommended
```

常见运行错误：

| `error_code` | 说明 | 自动重试 |
| --- | --- | --- |
| `worker_configuration_error` | Worker 或模型参数配置错误 | 否 |
| `worker_execution_failed` | 未分类执行错误，包括指定项目不存在或不可见 | 否 |
| `project_summary_failed` | AI 总结失败或只能生成兜底结果 | 是，未超过任务重试次数时 |
| `project_processing_failed` | 所有项目处理失败 | 依据 `retry_recommended` |
| `project_processing_partial_failed` | 部分项目处理失败 | 依据 `retry_recommended` |
| `cancel_requested` | 用户请求取消 | 否 |

指定项目在 OA 返回的项目列表中不存在或当前用户不可见时，运行失败并返回：

```json
{
  "status": "failed",
  "error_code": "worker_execution_failed",
  "error_summary": "OA 项目 51 不存在或不可见",
  "retry_recommended": false
}
```

## 10. 重试与覆盖规则

- 仅 AI 总结失败且 `retry_recommended=true` 时创建自动重试；
- GitHub `404`、错误仓库地址、指定项目不存在等配置问题不自动重试；
- 重试继承首次运行的 `project_id`、`summary_scope`、模型、提示词和任务快照；
- 手动运行会强制重新生成总结；
- 同一项目同一天已有总结时，手动运行允许覆盖；
- 自动重试采用受管写入规则，不覆盖无法确认归属的人工修改。

## 11. 前端推荐流程

1. 使用 `sessionid` 创建手动运行。
2. 保存响应中的 `run_id`。
3. 每隔数秒查询运行详情和 Trace。
4. 状态为 `pending`、`claimed`、`running` 时继续轮询。
5. 进入终态后停止轮询并展示项目结果、总结或错误摘要。
6. 用户取消时调用取消接口，并继续轮询直到状态变为 `cancelled`。

调用方不得：

- 将 GitHub Token 放入请求字段、Header、提示词或日志；
- 使用内部 Worker Token 调用浏览器接口；
- 把 HTTP `202` 当作总结成功；
- 因暂时没有 Trace 事件就重复创建运行；
- 在同一任务已有活动运行时绕过 `409 job_already_running`。
