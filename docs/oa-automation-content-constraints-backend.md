# OA 自动任务内容约束后端新增说明

## 1. 目标

为自动任务页面的“配置”入口提供真实 OA 持久化能力，使管理员可以修改所有自动任务共享的系统提示词，并让 OAagent Worker 在后续运行中使用、记录和审计对应版本。

当前前端已恢复旧版按钮、`WelcomeModal` 模态框、固定能力展示、系统提示词文本区和二次确认交互，但确认修改后尚未调用 OA 接口。OA 接口完成后，前端应改为以服务端配置为准。

## 2. 配置作用域

当前按 `job_type` 保存一份提示词配置：

```text
github_project_progress_sync
```

这样同类型的多个调度任务共享一致的内容政策，同时避免把提示词塞入模型参数。未来如果需要任务实例级覆盖，可增加 `job_id` 可空字段，并使用“任务实例配置优先、job_type 默认配置兜底”的规则。

不建议把系统提示词写入 `model_parameters`。`model_parameters` 应继续只承载 `reasoning_effort`、`max_output_tokens` 等模型运行参数；提示词属于业务配置、版本管理和审计数据。

## 3. 数据库

新增表 `automation_prompt_profiles`：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | bigint | PK | 主键 |
| `job_type` | varchar(100) | UNIQUE, NOT NULL | 当前仅允许 `github_project_progress_sync` |
| `system_prompt` | text | NOT NULL | 可编辑的全局自动任务约束上下文，1～16000 字符 |
| `prompt_version` | varchar(100) | NOT NULL | 服务端生成的不可变版本标识 |
| `enabled` | boolean | NOT NULL, default true | 是否应用该配置 |
| `version` | int | NOT NULL, default 1 | 乐观锁版本 |
| `created_by` | bigint | nullable | 创建人 OA 用户 ID |
| `updated_by` | bigint | nullable | 最后修改人 OA 用户 ID |
| `created_at` | datetime(6) | NOT NULL | UTC 时间 |
| `updated_at` | datetime(6) | NOT NULL | UTC 时间 |

迁移应为 `github_project_progress_sync` 写入前端旧版组件中的默认配置：

```json
{
  "system_prompt": "你是 OAAgent 的自动任务执行助手。请仅在用户明确配置的范围内执行任务，并遵循以下约束：\n\n1. 跟踪 GitHub 项目时，只读取和更新与当前任务直接相关的项目、字段、状态和进度。\n2. 调用 RWKVOS 系统功能前，确认调用目的与自动任务目标一致，不执行未授权的系统操作。\n3. 遇到信息缺失、权限不足或可能造成不可逆影响的操作时，停止执行并记录原因。\n4. 每次执行完成后，输出简洁、可核验的结果摘要。"
}
```

`prompt_version` 推荐使用规范化后 `system_prompt` 的 SHA-256，例如 `sha256:<24位摘要>`；内容没有变化时版本不变化。

## 4. 管理接口

接口沿用普通 OA 用户 Session 鉴权和现有统一响应 envelope。若后续重新启用细粒度权限，GET 对应 `automation:read`，PATCH 对应 `automation:write` 或 `automation:admin`。

### 4.1 查询配置

```http
GET /automation-prompt-profiles/github_project_progress_sync
```

成功响应：

```json
{
  "code": 200,
  "message": "ok",
  "data": {
    "id": 1,
    "job_type": "github_project_progress_sync",
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "required_capabilities": ["github_project_tracking", "rwkvos_system_calls"],
    "prompt_version": "sha256:1234567890abcdef12345678",
    "enabled": true,
    "version": 3,
    "updated_by": 51,
    "updated_at": "2026-07-31T12:00:00Z"
  },
  "success": true
}
```

### 4.2 修改配置

```http
PATCH /automation-prompt-profiles/github_project_progress_sync
Content-Type: application/json
```

请求：

```json
{
  "system_prompt": "你是 OAAgent 的自动任务执行助手。",
  "enabled": true,
  "version": 3
}
```

规则：

- `system_prompt` trim 后不能为空，最大 16000 字符。
- `required_capabilities` 由服务端固定返回，当前两个能力始终启用，管理接口不接受客户端修改。
- 拒绝 NUL 等不可见控制字符，保留换行和常用空白。
- 使用 `version` 做乐观锁；冲突返回 HTTP 409、`error_code=automation_prompt_version_conflict`。
- 内容变化时递增 `version`、重新计算 `prompt_version`、记录 `updated_by/updated_at`。
- 内容相同的重复请求按幂等成功处理，不重复递增版本。

建议错误：

| HTTP | `error_code` | 场景 |
| --- | --- | --- |
| 404 | `automation_prompt_profile_not_found` | 不支持的 `job_type` |
| 409 | `automation_prompt_version_conflict` | 乐观锁冲突 |
| 422 | `automation_prompt_invalid` | 字段为空、超长或包含非法控制字符 |

## 5. 调度与运行快照

创建 `automation_job_runs` 时必须把当时配置固化为运行快照，后续修改不能影响已创建或正在执行的运行。

建议在 `automation_job_runs` 增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt_version_snapshot` | varchar(100) | 创建运行时的配置版本 |
| `system_prompt_snapshot` | mediumtext | 创建运行时的系统提示词 |

`POST /internal/automation-job-runs/claim` 返回中增加：

```json
{
  "prompt_profile": {
    "prompt_version": "sha256:1234567890abcdef12345678",
    "system_prompt": "你是 OAAgent 的自动任务执行助手。",
    "required_capabilities": ["github_project_tracking", "rwkvos_system_calls"]
  }
}
```

该字段必须来自运行快照，而不是 claim 时重新查询最新配置。

## 6. OAagent Worker 处理

OAagent 收到 `prompt_profile` 后按以下顺序组装最终系统提示词：

```text
Worker 内置且不可编辑的安全规则
系统提示词 system_prompt
```

安全要求：

- 用户配置不能覆盖 Worker 固定的注入防护、Secret 禁止输出和不可信数据隔离规则。
- 项目名、仓库名、commit subject、作者和文件路径继续只作为数据输入，不能被当作指令。
- claim 未返回配置时，Worker 使用当前代码内置默认提示词，并在审计中记录 fallback。
- Worker 回传 AI interaction 时，`prompt_version` 和 `system_prompt_snapshot` 必须使用本次运行快照。

## 7. 审计接口

运行详情中的 AI interaction 增加：

```json
{
  "prompt_version": "sha256:1234567890abcdef12345678",
  "system_prompt_snapshot": "你是 OAAgent 的自动任务执行助手。"
}
```

保留清理可以清空大文本快照，但必须保留 `prompt_version`，以便统计某个配置版本对应的运行结果。

## 8. 前端接入点

OA 接口完成后，OAagent 前端需要：

1. 在 Next.js BFF 增加 `GET/PATCH /api/automation/prompt-profiles/{jobType}` 代理。
2. 在 `frontend/lib/automation-api.ts` 增加查询和修改类型与函数。
3. 弹窗打开时优先读取 OA 配置，并显示 `version`、修改人和修改时间。
4. 用户在二次确认中准确输入“确认修改”后提交 OA `PATCH`；成功后更新服务端版本并关闭弹窗。
5. HTTP 409 时提示“配置已被其他人修改”，提供重新加载按钮，不自动覆盖。
6. OA 请求失败时保留当前文本区中的未提交内容，不能关闭弹窗或提示修改已生效。

## 9. 验收标准

- 普通已登录用户可以读取配置；具备写权限的用户可以修改。
- 两个用户同时修改时，后提交的旧版本请求返回 409。
- 新运行使用保存后的 `prompt_version`，已经创建的运行继续使用旧快照。
- Worker 实际请求、运行审计和最终总结能关联到同一个 `prompt_version`。
- OAagent 不可用或 prompt 配置缺失时有确定性默认值和明确审计记录。
- 配置中的敏感信息不会出现在普通任务列表、应用日志或错误响应中。
