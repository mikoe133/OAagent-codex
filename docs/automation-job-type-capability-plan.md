# 自动任务 Job Type 能力规划

## CAPABILITY

OA 普通用户可以在“新建自动任务”中从系统内置目录选择一个专用业务任务或通用任务模板，配置调度、模型、标签和提示词后创建任务。`job_type` 决定代码执行器、可读取的数据、允许的业务写入和审计结构；提示词只能在该类型授予的能力范围内影响分析重点与表达方式。

当前创建入口在该能力完成前显示“功能开发中”，不能继续把所有新任务静默创建为 `github_project_progress_sync`。

## CONSTRAINTS

### 固定规则

1. `job_type` 是执行契约，不由任务名称、标签或提示词推断。
2. 以下完整业务流程只允许绑定到 `github_project_progress_sync`：
   - 读取全部 OA 项目；
   - 跳过归档项目并读取有效 GitHub 仓库；
   - 读取和聚合当天 Commit；
   - 使用 Agent 生成每日项目总结；
   - 根据 240 小时活动阈值切换“维护中/更新中”；
   - 写入 OA Commit 总结、项目状态、项目运行结果和 AI 审计。
3. 其他 `job_type` 即使配置了相同提示词，也不能获得项目状态修改或每日 Commit 总结写入权限。
4. OA 保存任务、调度、运行快照和审计；OAagent 保存执行器注册表并执行 GitHub、Agent 和业务写入。
5. OA 与 OAagent 必须使用相同的稳定 `job_type` 标识和版本化配置 Schema。
6. 新运行必须固化 `job_type`、执行配置、模型、提示词和能力快照；任务后续修改不能改变历史运行。
7. 所有写入必须有稳定幂等键、明确的目标资源和最小权限，不提供“提示词调用任意 OA 接口”的通用写入能力。

### 建议内置目录

| `job_type` | 分类 | 数据范围 | 允许写入 | 状态 |
| --- | --- | --- | --- | --- |
| `github_project_progress_sync` | 专用业务 | 全部 OA 项目、GitHub 全分支 Commit、当天数据 | Commit 日总结、项目状态、运行与 AI 审计 | 已实现 |
| `github_project_weekly_report` | 专用业务 | 活跃项目、本周 Commit、每日总结、当前状态 | 项目周报、运行与 AI 审计 | 待开发 |
| `github_release_digest` | 专用业务 | 指定仓库 Tag、Release、版本区间 Commit | 发布摘要、运行与 AI 审计 | 待开发 |
| `project_activity_risk_scan` | 专用业务 | 项目状态、提交频率、失败运行、负责人信息 | 风险记录或通知、运行与 AI 审计 | 待开发 |
| `project_insight_report` | 通用模板 | 允许选择项目、Commit、已有总结和运行记录，使用受控时间窗口 | 通用项目报告、运行与 AI 审计 | 待开发 |
| `oa_resource_digest` | 通用模板 | OA 白名单只读资源与过滤条件 | 摘要记录或通知、运行与 AI 审计 | 待开发 |

首期不建议提供 `arbitrary_agent_task`、任意 URL、任意 OpenAPI operation 或任意写入目标。这些设计会让提示词绕过任务类型的权限边界。

## IMPLEMENTATION CONTRACT

### 参与方

- OA 用户：选择任务类型并配置允许公开的字段。
- OA 前端：读取任务类型目录，按 Schema 渲染表单并提交稳定 `job_type`。
- OA 服务端：校验任务类型和配置，生成不可变运行快照，负责调度、租约、重试和审计查询。
- OAagent Worker：声明支持的任务类型，从执行器注册表解析 handler，执行受控数据读取、Agent 调用和业务写入。

### 前端交互

1. 新建任务第一步选择“任务类型”，分组展示“专用业务”和“通用模板”。
2. 每个类型展示用途、读取范围、写入范围、是否会修改业务状态和当前可用状态。
3. 选择类型后再显示调度、模型、标签、提示词和类型专属配置。
4. 已创建任务不能直接修改 `job_type`；需要复制为新任务，避免执行语义漂移。
5. 未启用、OAagent 不支持或 Schema 版本不兼容的类型不可创建或启用。

### OA 服务端接口

新增任务类型目录：

```http
GET /automation-job-types
GET /automation-job-types/{job_type}
```

建议目录响应：

```json
{
  "job_type": "github_project_progress_sync",
  "display_name": "GitHub 项目每日进度",
  "category": "specialized",
  "description": "汇总当天 Commit 并维护项目状态",
  "executor_version": "1",
  "configuration_schema_version": "1",
  "configuration_schema": {},
  "required_capabilities": [
    "oa_projects_read",
    "github_commits_read",
    "oa_commit_summaries_write",
    "oa_project_status_write",
    "automation_audit_write"
  ],
  "business_mutations": [
    "project_status",
    "github_commit_summary"
  ],
  "available": true
}
```

创建和更新任务需要增加：

```json
{
  "job_type": "project_insight_report",
  "job_configuration": {
    "project_scope": "active_projects",
    "time_range": "current_week",
    "data_sources": ["github_commits", "daily_project_summaries"],
    "output_target": "project_report"
  },
  "job_type_schema_version": "1"
}
```

OA 必须拒绝目录外类型、未知配置字段、过期 Schema 版本和越权能力组合。claim 响应增加不可变的 `job_configuration_snapshot`、`job_type_schema_version` 和 `required_capabilities`。

### OAagent 执行器注册表

```text
job_type
  -> metadata
  -> configuration validator
  -> executor factory
  -> capability policy
  -> audit serializer
```

注册表首期包含：

```text
github_project_progress_sync -> ProjectProgressSyncExecutor
github_project_weekly_report -> ProjectWeeklyReportExecutor
github_release_digest        -> ReleaseDigestExecutor
project_activity_risk_scan   -> ProjectRiskScanExecutor
project_insight_report       -> ConfigurableProjectReportExecutor
oa_resource_digest           -> ConfigurableOaDigestExecutor
```

`ProjectProgressSyncExecutor` 独占以下 writer：

```text
updateProjectStatus
createOrUpdateGitHubCommitSummary
```

其他执行器不能注入这两个 writer。该限制必须由依赖注入和运行前能力校验共同保证，不能只写在提示词中。

### 通用任务配置边界

通用任务只允许组合代码已注册的能力：

- 数据源：OA 项目、GitHub Commit、每日总结、自动化运行记录；
- 时间窗口：当天、当前周、最近 7 天、当前月；
- 输出 Schema：项目报告、风险列表、摘要通知；
- 写入目标：通用报告、风险记录、通知和自动化审计。

增加 Jira、Sentry、CI 日志或新的 OA 写入模块时，必须先实现并注册连接器或 writer；仅修改提示词不能获得这些能力。

### 状态与失败处理

1. 任务创建后先处于 `unverified`，OA 实时验证 OAagent 是否支持类型及配置。
2. 验证成功进入 `valid`，才允许启用和手动触发。
3. Worker 不支持类型时返回 `configuration_error/unsupported_job_type`，不重试。
4. Schema 版本不兼容时返回 `configuration_error/job_configuration_version_mismatch`。
5. 数据源暂时不可用可重试；业务写入冲突进入 `partial_failed` 并保留项目级结果。
6. 通用任务发现提示词请求未授权能力时拒绝调用并记录安全审计。

### 可观测性

运行详情至少展示：

- 任务类型、执行器版本和配置 Schema 版本；
- 配置、模型、提示词和能力快照；
- 实际使用的数据源与写入目标；
- Agent 工具调用次数、输入输出 Token、耗时和兜底状态；
- 每项业务写入的幂等键、结果和失败原因。

## NON-GOALS

- 本阶段不允许用户自定义新的 `job_type` 字符串。
- 本阶段不允许运行任意脚本、Shell、网页操作或任意 OA API。
- 提示词不能修改调度器、权限、时间范围上限或写入策略。
- 不把现有 `github_project_progress_sync` 改造成同时承担周报、发布说明和风险扫描的万能执行器。
- 不自动迁移或改写现有任务的 `job_type`。

## OPEN QUESTIONS

1. 项目周报最终写入现有周报模块还是新增“项目周报”资源？
2. 风险扫描结果写入项目风险表、OA 通知，还是两者都写？
3. 通用报告是否允许选择单个项目、标签项目集合和全部活跃项目三种范围？
4. 任务类型目录由 OA 数据库维护还是由 OAagent 注册表同步？建议 OA 展示缓存、OAagent 作为执行能力事实来源。
5. 一个 `job_type` 是否限制只能存在一个已启用任务？`github_project_progress_sync` 建议全局唯一启用。
6. 任务类型和配置 Schema 升级时，旧任务采用冻结旧版本还是强制迁移？

## HANDOFF

当前方案需要先进行 OA 与 OAagent 的接口评审，再进入实现。建议按以下顺序交付：

1. OAagent 建立只包含现有类型的执行器注册表和类型目录接口，保持现有 Worker 行为不变。
2. OA 服务端代理并缓存任务类型目录，新增 `job_configuration`、Schema 版本和运行快照字段。
3. 前端接入类型选择器，只有目录中 `available=true` 的类型可以创建。
4. 将 `github_project_progress_sync` 迁移到注册表，并增加“唯一启用”和独占 writer 测试。
5. 实现 `project_insight_report` 通用只读报告执行器，验证配置驱动链路。
6. 实现 `github_project_weekly_report`，补齐 OA 周报写入接口与按周幂等。
7. 最后开放“新建自动任务”入口，并进行权限、重试、审计和多 Worker 并发验收。
