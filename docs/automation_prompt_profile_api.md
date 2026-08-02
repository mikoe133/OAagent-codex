# 自动任务系统提示词持久化 API

本文档用于 OAagent 前端与 OA 服务端联调自动任务系统提示词的查询、持久化修改、版本控制和运行快照。

## 1. 功能范围

- 按 `job_type` 保存一份共享系统提示词配置
- 当前支持的 `job_type`：`github_project_progress_sync`
- 同类型的多个自动任务共享该配置
- 系统提示词不写入任务的 `model_parameters`
- 新运行创建时固化提示词内容与版本，后续修改不影响已有运行
- GET 和 PATCH 都只要求普通 OA 用户登录，不检查 `automation:*` 或 `admin` 权限

## 2. 请求地址与认证

OA 服务端接口没有额外 `/api` 前缀：

```text
GET   /automation-prompt-profiles/{job_type}
PATCH /automation-prompt-profiles/{job_type}
```

浏览器请求直接携带 OA 登录 Cookie。非浏览器联调可以使用以下任一方式：

```http
Cookie: sessionid=<OA_SESSION_ID>
```

```http
sessionid: <OA_SESSION_ID>
```

不要使用：

```http
Authorization: sessionid=<OA_SESSION_ID>
Authorization: Bearer <OA_SESSION_ID>
```

PATCH 请求还需携带：

```http
Content-Type: application/json
```

## 3. 通用响应结构

成功和失败都使用 OA 统一响应 envelope：

```json
{
  "code": 200,
  "message": "ok",
  "data": {},
  "success": true
}
```

HTTP 状态码和响应体中的 `code` 保持一致。

## 4. 查询系统提示词配置

### 4.1 请求

```http
GET /automation-prompt-profiles/github_project_progress_sync
```

cURL：

```bash
curl "$OA_BASE_URL/automation-prompt-profiles/github_project_progress_sync" \
  --header "sessionid: $OA_SESSION_ID"
```

### 4.2 成功响应

```json
{
  "code": 200,
  "message": "ok",
  "data": {
    "id": 1,
    "job_type": "github_project_progress_sync",
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "required_capabilities": [
      "github_project_tracking",
      "rwkvos_system_calls"
    ],
    "prompt_version": "sha256:e72020c784f0e4adfd0b9da4",
    "enabled": true,
    "version": 3,
    "created_by": null,
    "updated_by": 51,
    "created_at": "2026-07-31T08:00:00Z",
    "updated_at": "2026-07-31T12:00:00Z"
  },
  "success": true
}
```

### 4.3 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 配置记录 ID |
| `job_type` | string | 自动任务类型，当前仅支持 `github_project_progress_sync` |
| `system_prompt` | string | 当前持久化的共享系统提示词 |
| `required_capabilities` | string[] | 服务端固定能力，客户端只读 |
| `prompt_version` | string | 规范化提示词内容的 SHA-256 摘要版本 |
| `enabled` | boolean | 是否将该配置应用到新创建的运行 |
| `version` | integer | 配置乐观锁版本，PATCH 时必须原样回传 |
| `created_by` | integer/null | 创建人 OA 用户 ID；默认 seed 为 `null` |
| `updated_by` | integer/null | 最后修改人 OA 用户 ID |
| `created_at` | string | UTC ISO 8601 创建时间 |
| `updated_at` | string | UTC ISO 8601 修改时间 |

`required_capabilities` 当前固定为：

```json
[
  "github_project_tracking",
  "rwkvos_system_calls"
]
```

PATCH 不接受客户端修改该字段。

## 5. 修改系统提示词配置

### 5.1 请求

```http
PATCH /automation-prompt-profiles/github_project_progress_sync
Content-Type: application/json
```

```json
{
  "system_prompt": "你是 OAAgent 的自动任务执行助手。",
  "enabled": true,
  "version": 3
}
```

cURL：

```bash
curl --request PATCH \
  "$OA_BASE_URL/automation-prompt-profiles/github_project_progress_sync" \
  --header "sessionid: $OA_SESSION_ID" \
  --header "Content-Type: application/json" \
  --data '{
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "enabled": true,
    "version": 3
  }'
```

### 5.2 请求字段

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `system_prompt` | string | 是 | trim 后 1～16000 字符 |
| `enabled` | boolean | 是 | 是否应用到以后创建的运行 |
| `version` | integer | 是 | 必须大于等于 1，并与 GET 返回的当前版本一致 |

请求模型为严格模式，不能提交 `required_capabilities` 或其他未定义字段。

### 5.3 文本规范化与校验

- `CRLF` 和单独的 `CR` 会统一转换为 `LF`
- 文本首尾空白会被 trim
- 保留正文中的换行和 Tab
- 拒绝空内容
- 拒绝超过 16000 字符的内容
- 拒绝 NUL、零宽字符等不可见控制字符

服务端使用规范化后的内容计算：

```text
prompt_version = "sha256:" + SHA256(system_prompt) 的前 24 位十六进制摘要
```

### 5.4 成功响应

成功返回修改后的完整配置：

```json
{
  "code": 200,
  "message": "ok",
  "data": {
    "id": 1,
    "job_type": "github_project_progress_sync",
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "required_capabilities": [
      "github_project_tracking",
      "rwkvos_system_calls"
    ],
    "prompt_version": "sha256:e72020c784f0e4adfd0b9da4",
    "enabled": true,
    "version": 4,
    "created_by": null,
    "updated_by": 51,
    "created_at": "2026-07-31T08:00:00Z",
    "updated_at": "2026-07-31T12:10:00Z"
  },
  "success": true
}
```

## 6. 乐观锁与幂等规则

正常修改流程：

1. GET 获取当前 `system_prompt`、`enabled` 和 `version`
2. 用户修改内容并确认
3. PATCH 时回传 GET 得到的 `version`
4. 成功后使用响应中的新 `version` 更新本地状态

配置内容或 `enabled` 变化时：

- `version` 递增 1
- `updated_by` 更新为当前 OA 用户 ID
- `updated_at` 更新为当前 UTC 时间
- 仅当 `system_prompt` 变化时重新计算 `prompt_version`

如果 PATCH 的 `system_prompt` 和 `enabled` 已经与服务端完全一致，则按幂等成功处理，即使请求携带的是修改前版本，也不会再次递增版本或覆盖 `updated_by`。

如果内容不同且 `version` 已过期，则返回 409，服务端不会覆盖新配置。

## 7. 错误码

| HTTP | `error_code` | 场景 | 客户端处理建议 |
| --- | --- | --- | --- |
| 401 | 无业务错误码 | OA session 缺失、失效或用户不存在 | 重新登录 |
| 404 | `automation_prompt_profile_not_found` | 不支持的 `job_type` 或配置 seed 未执行 | 检查路径和数据库迁移 |
| 409 | `automation_prompt_version_conflict` | 修改内容不同且乐观锁版本过期 | 重新 GET，提示用户确认最新内容 |
| 422 | `automation_prompt_invalid` | 提示词为空、超长或包含非法控制字符 | 保留输入并展示校验错误 |
| 422 | `extra_forbidden` | 请求包含未定义字段 | 删除多余字段后重试 |

版本冲突示例：

```json
{
  "code": 409,
  "message": "自动任务内容配置版本冲突",
  "data": {
    "error_code": "automation_prompt_version_conflict",
    "details": null
  },
  "success": false
}
```

输入校验失败示例：

```json
{
  "code": 422,
  "message": "请求参数校验失败",
  "data": {
    "error_code": "automation_prompt_invalid",
    "details": [
      {
        "type": "automation_prompt_invalid",
        "loc": ["body", "system_prompt"],
        "msg": "system_prompt must contain 1 to 16000 characters"
      }
    ]
  },
  "success": false
}
```

## 8. 运行快照和 Worker 契约

提示词配置不会在 Worker claim 时临时读取。OA 在创建根运行时将以下字段固化到 `automation_job_runs`：

```text
prompt_version_snapshot
system_prompt_snapshot
```

规则：

- 定时运行和手动运行创建时读取当前 enabled 配置并固化
- 重试运行继承根运行的提示词快照
- 修改配置不会影响已经创建、等待执行、正在执行或重试中的运行
- 配置缺失或 `enabled=false` 时，新运行的提示词快照为空

Worker claim 返回：

```json
{
  "prompt_profile": {
    "prompt_version": "sha256:e72020c784f0e4adfd0b9da4",
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "required_capabilities": [
      "github_project_tracking",
      "rwkvos_system_calls"
    ]
  }
}
```

如果没有可用配置：

```json
{
  "prompt_profile": null
}
```

此时 Worker 使用内置默认提示词，并在 AI interaction 审计中记录 `fallback_used=true`。

Worker 回传 AI interaction 时，`prompt_version` 和 `system_prompt_snapshot` 必须与本次 claim 完全一致；不一致返回：

```text
HTTP 422
error_code = automation_prompt_snapshot_mismatch
```

## 9. 前端推荐接入流程

1. 打开系统提示词配置弹窗时调用 GET
2. 使用响应中的 `system_prompt` 初始化文本区
3. 显示 `version`、`updated_by`、`updated_at` 和 `prompt_version`
4. 用户完成二次确认后调用 PATCH
5. PATCH 成功后使用响应更新页面状态并关闭弹窗
6. 409 时保留用户未提交内容，提示“配置已被其他人修改”并提供重新加载
7. 401、404、422 或网络失败时不能提示“修改成功”，也不能清空用户输入

## 10. 数据库迁移

如果现有环境已经执行到软删除迁移 `003`，按顺序执行：

```bash
mysql < scripts/sql/20260731_004_add_automation_prompt_profiles.up.sql
mysql < scripts/sql/20260731_005_seed_automation_prompt_profile.up.sql
```

- `004`：创建 `automation_prompt_profiles`，并给运行表增加提示词快照字段
- `005`：写入 `github_project_progress_sync` 默认提示词
- seed 使用唯一键幂等插入，不覆盖已经存在的配置

只更新代码、不执行这两份 SQL，会导致接口查询表或运行快照字段时报数据库错误。

## 11. 安全约束

- 系统提示词不会出现在普通任务列表接口
- 系统提示词不会写入应用日志或错误响应
- `required_capabilities` 由服务端固定，客户端不能削弱或扩展
- Worker 必须先拼接内置且不可编辑的安全规则，再拼接本接口配置的 `system_prompt`
- 仓库名、项目名、commit subject、作者和文件路径只能作为数据，不能作为系统指令
- 不要在系统提示词中保存 token、Cookie、API key、密码或其他凭证

相关文档：

- [自动化任务与执行审计 API](automation_api.md)
- [OAagent 与 OA 自动化联调 API](oaagent_integration_api.md)
