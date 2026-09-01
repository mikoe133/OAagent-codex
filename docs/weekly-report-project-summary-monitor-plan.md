# 周报更新驱动的项目总结监控任务

## CAPABILITY

OA/管理员可以预置一种“监控任务”，监听指定范围内的 OA 周报新增或内容更新。当检测到有效变化时，任务读取变更后的完整周报和项目目录，将周报内容安全地拆分到对应项目，并调用受控的项目周报/总结写入接口；同一次周报变更只产生一次逻辑处理，重复事件和 Worker 重试不会造成重复写入。由于监控任务包含垂直业务逻辑，当前前端不提供通用新建表单，只展示已预置任务并允许受控启停。

这不是按时间执行的业务任务。任务的业务触发条件是 `weekly_report.created` 或 `weekly_report.updated`；如果采用轮询作为可靠性兜底，轮询只属于监控基础设施，只有发现内容版本或内容哈希变化时才创建运行。

当前仓库已提供该能力的 OAagent 侧实现：自动任务契约、事件入口、持久化去重、Worker Executor、项目拆分和前端任务表单均支持 `weekly_report_project_summary_sync`。OA 侧仍需补充稳定的周报资源 ID/版本/更新时间、事务 Outbox 和事件投递。

## CONSTRAINTS

### 固定规则

1. 新增独立的稳定任务类型，例如 `weekly_report_project_summary_sync`，不能把提示词塞进 `github_project_progress_sync`。
2. `job_type` 决定执行器、数据源、写入目标和能力；用户提示词不能扩大权限，也不能选择任意 OA operation。
3. 事件必须在周报写入事务提交后投递。推荐 OA outbox + 投递器；只在请求结束后同步 HTTP 回调不能作为唯一可靠机制。
4. 事件优先携带周报资源指针和版本/哈希；Worker 在有完整事件快照时按该版本处理，否则回读 OA 权威内容。若 OA 已提供详情接口，生产环境建议始终回读并校验版本。
5. 同一周报资源的事件按版本或内容哈希单调处理。重复事件、重复投递和运行重试必须复用同一个逻辑结果。
6. 周报内容是非可信数据，必须作为被分析文本传给模型，不能作为系统指令或工具调用指令。
7. 项目匹配必须优先使用稳定 `project_id`，其次使用规范化名称/别名；名称不唯一或置信度不足时不写入，进入人工复核结果。
8. 一次运行中单个项目失败不能阻断其他项目；最终状态保留项目级成功、未匹配、歧义、冲突和失败原因。
9. 项目写入必须使用稳定幂等键、目标资源和版本 CAS。默认不因周报删掉一段文字而删除或清空历史项目总结。
10. 周报所属用户/租户范围必须由任务配置和 OA 权限确定。普通用户默认只能监听自己的周报；跨用户监听需要管理员能力。
11. 本需求确认复用现有 GitHub Commit 日总结接口：`summary` 写该项目从周报拆出的更新点，`ai_note` 写带时间标识的周报来源内容；`summary_date` 仍然是日期字段，不能写文本。
12. `summary_date` 必须使用稳定的周报归属日期，建议使用周末日期或 OA 周报明确提供的业务日期，不能使用每次编辑时变化的 `updated_at` 日期。
13. 所有运行都冻结任务类型、配置、模型、提示词、能力和源周报版本快照；后续修改任务不能改变历史运行含义。

### 当前实现边界

- OAagent 已支持 `schedule_type=event`、`trigger_source=event` 和 `weekly_report_project_summary_sync` Worker claim。
- 项目拆分当前由 Agent 读取周报内容并按项目 allowlist 归纳；Agent 输出经过 ID 白名单、置信度阈值和内容清洗后分别写入项目总结。Agent 失败时使用项目 ID、精确名称和别名的确定性匹配兜底，未匹配内容不写入。
- 目标仍是现有 GitHub Commit 日总结接口：`summary` 写项目更新点，`ai_note` 写带周报时间和项目片段的来源说明。
- OA 周报服务仍需提供详情读取接口及事务 Outbox；事件 payload 可携带完整内容作为当前兼容快照。

## IMPLEMENTATION CONTRACT

### 参与方

- OA/管理员：通过 OA 侧垂直配置或预置流程创建监控任务，配置周报范围、项目范围和歧义处理策略。
- OA 周报服务：在事务提交后写 outbox 事件，提供可按资源 ID读取的权威周报。
- OA 自动化服务：保存任务、接收事件、去重/合并事件、创建运行、租约、重试和审计。
- OAagent Worker：声明支持任务类型，读取周报和项目目录，执行受控拆分，并调用专用项目总结 writer。
- OA 前端：展示已预置任务的监听状态、只读垂直业务配置、可复用的通用任务元数据、最近事件、运行结果和需要人工复核的项目；当前不从通用自动任务表单创建监控任务。

### 调用边界

OAagent 需要提供的是 `weekly_report_project_summary_sync` 的受控执行能力（Executor + 能力注册），不建议提供一个由 OA 直接调用、同步执行完整任务的 `POST /execute` 接口。推荐链路是：

1. OA 周报写入事务提交后，通过 Outbox 调用自动化服务的事件入口；该入口只负责验签、去重和入队，返回 `202`。
2. 自动化服务创建 `pending` Run，并保存事件、源周报版本和任务配置快照。
3. OAagent Worker 在 claim 请求中声明支持 `weekly_report_project_summary_sync`，领取 Run 后由本地 Executor 根据 `job_type` 路由执行。
4. Executor 再使用受限项目同步凭证调用 OA 的周报读取、项目读取以及现有 GitHub Commit 总结 POST/PATCH 接口。
5. Worker 按现有租约、heartbeat、幂等写入、Trace、审计和终态回传协议结束 Run。

因此，OA 调用的是“事件触发/入队接口”，不是“执行接口”；OAagent 暴露的是能力目录或健康校验接口（可选）以及已有 Worker 运行能力。若确实需要 OA 主动触发，也应让该接口只创建 Run，不能绕过队列、租约和审计直接执行。

### 任务配置

建议配置快照如下：

```json
{
  "trigger_type": "event",
  "source": {
    "resource": "weekly_report",
    "events": ["created", "updated"],
    "scope": "job_owner"
  },
  "project_scope": "all_current_projects",
  "include_archived_projects": true,
  "write_archived_projects": true,
  "matching": {
    "order": ["project_id", "exact_name", "alias", "model_assisted"],
    "minimum_confidence": 0.8,
    "on_ambiguous": "no_write",
    "on_unmatched": "record_and_continue"
  },
  "update_policy": "upsert_source_version",
  "debounce_seconds": 60,
  "stale_source_policy": "enqueue_latest"
}
```

`scope` 至少支持 `job_owner`；`all_users` 或用户白名单应仅向管理员开放。本需求确认所有项目包含归档项目，因此归档项目既参与匹配，也允许写入项目总结；`include_archived_projects` 与 `write_archived_projects` 仅为历史配置兼容字段，周报同步执行器始终按 `true` 处理；仍需由 OA 项目同步权限明确允许该操作。

### 事件契约

OA 在周报事务提交后向自动化事件入口投递：

```http
POST /internal/automation-events
Authorization: Bearer <OA_AUTOMATION_EVENT_TOKEN>
Content-Type: application/json
```

```json
{
  "event_id": "uuid",
  "event_type": "weekly_report.created",
  "aggregate_type": "weekly_report",
  "aggregate_id": "report-123",
  "aggregate_version": 7,
  "occurred_at": "2026-08-27T09:30:00Z",
  "actor_id": 42,
  "scope": {"user_id": 42},
  "data": {
    "weekly_num": 202635,
    "content_hash": "sha256:64-hex-characters",
    "updated_at": "2026-08-27T09:29:58Z"
  }
}
```

要求：

- `event_id` 全局唯一；相同 ID 和相同 payload 重放返回原结果，不创建新运行；相同 ID 携带不同 payload 返回冲突。
- `aggregate_version` 必须单调递增；如果 OA 暂时没有版本，至少提供 `updated_at + content_hash`，最终仍建议补充版本。
- 事件入口校验服务认证、签名时间窗和重放；不记录 Authorization、Cookie、raw token 或完整敏感内容。
- 事件入口返回 `202`，并返回 `event_id`、去重结果和关联 `run_id`（若已创建）。

### 事件到运行

```text
周报事务提交
  -> OA outbox
  -> 事件投递与验签
  -> event_id 去重
  -> 同一 report debounce/coalesce
  -> 创建 event run
  -> Worker claim/heartbeat
  -> 回读周报当前版本
  -> 读取项目目录快照
  -> Agent 读取 content 并按项目归纳
  -> 白名单/置信度校验（失败时确定性兜底）
  -> 按项目幂等写入
  -> 复核源版本并结束或追排最新版本
```

事件运行的并发键建议为 `tenant:weekly_report_project_summary_sync:report:{aggregate_id}`。同一周报已有 `pending/claimed/running` 时，不并行创建第二个处理；新版本进入 `pending_latest_version`，当前运行结束后自动追排一次最新版本。不同周报可以并行。

运行 `trigger_source` 需要新增 `event`，执行快照至少包含：`event_id`、`source_report_id`、`weekly_num`、`source_version`、`content_hash`、`scope`、`project_scope` 和 `matching_policy`。

### 回退监控

如果 OA 暂时不能提供 outbox 事件，增加一个独立的监控适配器，按 1～5 分钟读取周报索引，使用 `(report_id, version)` 或 `(report_id, content_hash)` 游标发现变化，然后走同一个事件入口。它不是用户可见的 cron 任务，也不能在每次轮询都创建运行。

轮询只能作为补偿通道：事件和轮询同时发现同一版本时仍按事件 ID/资源版本去重；轮询游标必须持久化；初次启用默认不回放所有历史周报，除非用户显式执行回放。

### 周报读取契约

需要新增或补充一个稳定的内部只读接口，例如：

```http
GET /internal/weekly-reports/{report_id}
```

响应至少包含：`id`、`weekly_num`、`owner_id`、`content`、`version`、`updated_at`、`deleted`。如果业务实际按“用户 + 周次”唯一，应明确返回 `owner_id + weekly_num`，不能仅依赖一个未定义的周次。

Worker 收到事件后按资源 ID回读；回读不到时，已提交事件可重试短暂一致性窗口，最终以 `source_not_found` 结束，不应调用模型或写项目。

### 拆分与匹配

1. 固定读取项目目录快照，包含 `project_id`、名称、别名、状态和目录版本；模型只能从项目 allowlist 中选择，不能自由猜项目 ID。
2. Agent 读取传入的完整周报 `content`，按项目输出归纳后的 `summary`、`confidence` 和 `reason`。
3. 对重复项目名、跨项目的一段内容、空段、超长段和无法识别段分别记录结果；低于阈值或歧义项目不写入。
4. Agent 不可用时，使用项目 ID、项目名称和别名进行确定性匹配兜底，并标记运行需要重试。
5. 记录源文本的段落范围或稳定片段哈希，便于审计和重跑；不要在日志中输出完整周报。

当前 Agent 输出：

```json
{
  "projects": [
    {
      "project_id": 51,
      "summary": "本周完成……",
      "confidence": 0.96,
      "reason": "项目名称匹配"
    }
  ],
  "unmatched": ["无法确定归属的段落"]
}
```

### 项目总结写入契约

本需求复用现有接口：

```http
POST /internal/project-sync/github-commit-summaries
PATCH /internal/project-sync/github-commit-summaries/{summary_id}
```

创建或更新的核心字段约定：

```json
{
  "project_id": 51,
  "summary_date": "2026-08-23",
  "summary": "本周完成自动任务接口联调，补充了周报更新监听。",
  "ai_confidence": 96,
  "ai_note": "2026年第35周周报：本周完成自动任务接口联调……",
  "run_id": "run-uuid",
  "run_mutation_token": "scoped-token",
  "fencing_token": 7,
  "idempotency_key": "sha256:64-hex-characters"
}
```

写入规则：

- `summary_date` 使用周报的稳定业务日期（建议周末日期），`summary` 只放当前项目的拆分更新点。
- `ai_note` 放“周报时间 + 周报来源内容”，必须限制长度；完整原文和内容哈希放运行审计/事件快照，不放日志。
- 使用 `source_report_id + project_id + summary_date` 查询 OAagent 的周报总结绑定。不存在绑定时 POST 新建独立 Commit 总结，存在绑定时只 PATCH 绑定的 `commit_summary_id`，并携带 `expected_version`。
- 同一周报的新版本和 Worker 重试复用绑定记录；不同 `source_report_id` 即使项目和日期相同，也分别新建独立记录。
- 来源 ID、版本、Commit 总结 ID 和最近运行 ID 保存在 `automation_weekly_report_summary_bindings`；运行快照、AI 审计和事件表继续保存本次执行证据。
- GitHub 日同步、其他周报和人工总结均视为其他来源，周报同步不得按 `project_id + summary_date` 更新查询结果中的任意记录。
- OA Commit 总结接口和数据表必须允许同一 `project_id + summary_date` 存在多条来源独立记录；如上游仍保留该组合唯一约束，必须先升级上游接口后再启用本规则。

### 状态与失败处理

建议阶段：`received` → `deduplicated` → `debounced` → `running` → `source_loaded` → `projects_loaded` → `split` → `writing` → `reconciled` → 终态。

- `succeeded`：所有可写项目成功，未匹配/无内容仅为告警。
- `partial_failed`：至少一个项目写入失败、版本冲突或需要人工复核，其余项目已处理。
- `failed`：源读取、认证、模型服务或共享前置条件失败，无法形成项目结果。
- `configuration_error`：任务类型、配置 Schema、目标接口或模型不支持，不重试。
- 源版本在运行期间变化：当前运行只处理快照版本；结束前发现新版本则创建/复用一个最新版本运行，不能把旧内容覆盖到新目标。
- 网络超时或 5xx 使用指数退避；重试必须复用原 `idempotency_key`、`interaction_key` 和源版本。

项目级 outcome 至少增加：`matched`、`no_change`、`unmatched`、`ambiguous_match`、`write_conflict`、`source_stale`、`failed`。

### 权限、安全和审计

任务类型能力建议为：

- `weekly_reports_read`
- `oa_projects_read`
- `github_commit_summaries_write`
- `automation_audit_write`

不要给该执行器注入任意 OpenAPI 客户端或项目状态 writer。事件入口使用独立服务凭证；项目写入继续使用受限的项目同步凭证，并同时校验 run、租约、fence 和目标版本。AI 审计只保存脱敏的输入摘要、输出结构、来源哈希、Token 和延迟；原始周报按最小保留期处理。

### 可观测性和前端

运行详情需要能看到：来源周报 ID/周次/版本、事件延迟、内容哈希、项目总数、匹配/歧义/未匹配数量、每个项目的写入幂等键和结果、最新版本追排情况。

当前 Worker 上报并由前端 `RunTraceSection` 展示的阶段包括：`worker_claimed`、`validate_configuration`、`load_weekly_report`、`load_projects`、`weekly_report_agent`、`split_weekly_report`、`write_project_summaries`、`write_project_summary:{project_id}`、`upload_run_audit` 和 `finalize_run`。其中项目级写入节点按项目 ID 独立更新，便于同时看到多个项目的进行中/完成/失败状态；读取、项目目录和 Agent 异常也会写入对应失败态。

监控任务详情与运维表单：

1. 监控任务由 OA/管理员通过垂直配置或预置流程创建，前端不提供通用新建入口。
2. 详情页隐藏执行频率、执行时间和 cron 字段，明确展示周报事件触发方式。
3. 复用通用表单配置任务启停、名称、说明、模型服务商、模型和标签。
4. 周报范围、归档项目、匹配策略、歧义处理和去抖时间由任务类型固定或由 OA 垂直配置，前端只读展示。
5. 展示“监听中/已暂停”、最近事件、最近成功版本、待人工复核数；测试拆分和版本回放作为后续受控运维入口。

## NON-GOALS

- 不把所有用户的周报默认汇总给普通用户任务。
- 不通过提示词调用任意 OA API、任意 URL、脚本或 Shell。
- 不在周报删除时自动删除项目历史总结。
- 不在没有确定 `summary_date` 和覆盖策略时写入现有 GitHub Commit 日总结。
- 不把监控任务伪装成每分钟创建一次的 cron 任务。
- 不在首期做历史周报全量回放；历史回放作为显式、可审计的运维动作。

## OPEN QUESTIONS

1. `summary_date` 的稳定取值是什么：周末日期、周报填写日期，还是 OA 另有业务日期字段？建议周末日期。
2. 周报是否按用户唯一，还是同一 `weekly_num` 可能有多个用户版本？需要明确 `report_id`、`owner_id` 和租户边界。
3. 周报更新是否有数据库版本号、更新时间和提交事务？若没有，OA 需要补充资源详情和 outbox 事件。
4. 周报内容是否有固定项目标题/ID格式？格式越稳定，模型调用越少、误匹配越低。
5. 一次更新中被删除的项目段落，目标总结应保留旧值、标记已移除，还是清空？建议首期保留旧值并记录差异。
6. `ai_note` 是否允许保存整段周报原文，还是只保存“周报时间 + 项目相关片段”？建议保存项目相关片段，完整原文只进审计。
7. 同一周报短时间连续保存时，去抖窗口取 30、60 还是 120 秒？建议默认 60 秒并支持配置。
8. 事件入口由 OA 直接调用 Node 自动化服务，还是由现有消息总线承载？建议先用 OA outbox + HTTP 投递，后续再替换传输层。

## HANDOFF

当前方案需要先做接口/数据语义评审，不能直接在现有 `github_project_progress_sync` 上改提示词。建议实施顺序：

1. 确认 `summary_date` 取值、同日 GitHub 总结的覆盖策略和权限边界。
2. 补齐 OA 周报详情的 `report_id/owner_id/version/updated_at`，并实现事务 outbox 与 `weekly_report.created/updated` 事件。
3. 扩展自动任务类型目录、`trigger_type=event`、事件去重表、游标/去抖和 `event` 运行快照；保留现有 cron 任务兼容性。
4. 在 OAagent 注册 `weekly_report_project_summary_sync` 执行器，先实现确定性拆分、只读 dry-run 和结构化匹配审计。
5. 复用现有 GitHub Commit 总结 writer，加入按日期查询、POST/PATCH、source-version 运行审计、幂等、租约/fence 和项目级 partial failure。
6. 前端先支持预置监控任务详情、通用元数据编辑和运行详情，对单个测试用户启用；观察事件延迟、匹配率、冲突率和重复率后扩大范围。
7. 最后再增加轮询补偿和显式历史回放，不把轮询频率暴露成用户的业务调度。

验收重点：重复事件只产生一个逻辑结果；同一周报新版本不会与旧版本并行覆盖；一个项目失败不影响其他项目；歧义项目零写入；目标版本冲突可审计且可人工重放；禁用任务不消费新事件；事件和运行审计中不出现 token 或完整敏感内容。
