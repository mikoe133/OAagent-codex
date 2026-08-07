# 项目进度 Worker 确定性取数与接口并发实施蓝图

- 状态：实施中，Step 0 Worker 契约已实现但 OA 服务端黑盒证据待验证；Step 1 Worker 基线与指标已实现
- 更新日期：2026-08-07
- 适用任务：`github_project_progress_sync`
- 目标时区：`Asia/Shanghai`
- 当前实现基线：单 Worker 进程、单活跃 OA run、GitHub/Agent/OA 业务写入并发 `6/2/1`

## 1. 决策摘要

采用“确定性代码编排 + 受限 Agent 语义分析”的混合架构：

```text
Worker claim
  -> 代码读取并校验 OA 项目
  -> 代码规范化、校验、去重 GitHub 仓库
  -> 代码读取仓库、分支和 Commit
  -> 代码生成稳定 RepositoryEvidence
  -> Agent 总结候选 Commit，并按需读取受限 Commit 详情
  -> 代码校验 Agent 输出、聚合项目结果
  -> 代码幂等写回 OA 并记录审计
```

接口路径、查询参数、分页、鉴权、重试、限流、状态判断、幂等和写回不得交给 Agent。Agent 只处理以下非确定性工作：

1. 判断哪些候选 Commit 标题不足以支撑总结；
2. 在允许的仓库和 SHA 集合内选择 Commit 详情；
3. 根据 Commit 标题、文件统计和受裁剪 Patch 提炼工程进展；
4. 返回结构化总结与真实限制。

不要把 OA 或 GitHub 原始响应整包放入模型上下文。代码先完成 schema 校验、字段白名单、排序、去重和裁剪，再生成稳定 DTO。

## 2. 当前实现、缺口与前置契约

### 2.1 已实现

- `ProjectProgressOaClient` 通过代码分页读取项目并校验响应；
- `syncProjectProgress` 通过代码读取项目详情，跳过归档项目，规范化并去重 `github_urls`；
- `GitHubRestProjectReader` 通过代码读取仓库元数据、分支和 Commit，并按 SHA 去重；
- 同一个 GitHub 仓库被多个 OA 项目引用时只读取、总结一次；
- 只有北京时间当天存在 Commit 的仓库进入 Agent 队列；
- Agent 只能调用 `read_commit_details`，仓库和 SHA 受候选集合约束；
- Commit 详情受调用次数、文件数、单文件 Patch 和总 Patch 字符预算约束；
- GitHub HTTP、Codex Thread、OA 项目业务 mutation 的默认并发分别是 `6/2/1`；
- Heartbeat 自身不会重叠发送，租约丢失会触发取消；
- 项目状态判断、项目级 fan-in、写回和确定性兜底均由代码负责。

### 2.2 待补强

- OA 项目详情当前按项目串行读取，没有独立 OA read limiter；
- OA 项目同步客户端和 GitHub 客户端没有请求级重试；
- GitHub 遇到 primary/secondary rate limit 时只报告错误，没有自适应降载；
- OA Trace 由并发仓库任务直接发送，不受有界队列或 telemetry limiter 约束；
- `PROJECT_PROGRESS_OA_WRITE_CONCURRENCY=1` 只覆盖项目状态和总结 mutation，不覆盖 Trace、run project、AI interaction 等自动化写入；
- 仓库任务和 Agent 任务用 `Promise.all + Semaphore` 创建全部等待项，队列长度未设上限；
- 当前并发配置是进程级限制。增加 Worker 副本会按副本数线性放大 GitHub、模型和 OA 压力；
- 指标只有峰值和任务计数，缺少接口延迟、排队时长、重试次数、429/5xx、GitHub rate remaining 等调参依据。

### 2.3 实施前置：OA 服务端 fencing 与条件写

本地并发器、`AbortSignal` 和单副本部署都不能阻止一个已经到达 OA 的旧 Worker mutation。要满足租约丢失后旧 Worker 不再生效，OA 必须先提供服务端 fencing：

1. Worker 在首次发送前持久化 `claim_request_id`、稳定 `worker_id` 和规范化请求摘要；OA 在至少覆盖最大 run 时长与恢复宽限期的幂等窗口内绑定三者，相同 ID 和相同请求返回同一 claim，不同请求复用同一 ID 返回 409；
2. claim 返回单调递增的 `fencing_token` 或 `lease_epoch`，以及服务端 HMAC 确定性派生的 scoped `run_mutation_token`。token 绑定 `run_id + worker_id + concurrency_key + fencing_token + token_version`，因此 claim 响应丢失或 Worker 重启后可以用持久化的 request ID 安全重取；bearer token 本身只驻留内存，不明文写入 SQLite；
3. 所有可能在租约失效后到达 OA 的 run-scoped mutation，包括项目状态、Commit 总结、run project、AI interaction、Trace 和 run 终态，都携带 `run_id`、`fencing_token`、`run_mutation_token`、`idempotency_key`；资源更新额外携带 `expected_version`；
4. OA 在同一数据库事务中验证 token HMAC 和 scope、run 仍持有有效租约、fencing token 未过期、资源 version 匹配和幂等键，然后执行 mutation；共享 `OA_PROJECT_SYNC_TOKEN` 只负责服务身份，不替代本次 run 的持有者证明；
5. 项目和总结读取响应稳定返回 `version`，状态与总结 PATCH 支持 `If-Match` 或等价 `expected_version`；
6. `running` 和终态 PATCH 明确同 payload 可重放，不同 payload 返回冲突；终态事务作为服务端 barrier，先锁定 run 并使其 token/fence 失效，与业务 mutation 串行裁决；
7. OA claim 按独立 `concurrency_key = tenant_id + job_type + writer_scope` 实施 single-flight，而不是只按 `job_key`。本任务的 `writer_scope=all_projects`，因此 cron、manual、retry 或不同 job key 也不能同时写同一租户的项目集合。

在该契约上线前：

- `claim` 响应未知时不得立即重试；
- Worker 只能保持单副本并依赖当前 read-before-write 降低风险；
- 文档和监控只能声称“取消后不主动发起新 mutation”，不能声称已在服务端阻止旧请求生效；
- 不启用自动接管后的并发写入，也不扩大 Worker 副本数。

## 3. 目标数据契约

Agent 输入采用稳定、最小化的仓库证据结构：

```ts
type RepositoryEvidence = {
  schemaVersion: "repository-evidence-v1";
  repository: {
    id: number;
    fullName: string;
  };
  businessDate: string;
  commits: Array<{
    sha: string;
    committedAt: string;
    subject: string;
  }>;
};
```

生成规则：

- `commits` 稳定排序；项目关联关系保留在 Worker work item 中，不进入模型输入；
- 同仓库同 SHA 只出现一次；
- 只保留允许进入提示词的字段，不携带 token、用户信息、完整 GitHub payload 或 OA 描述正文；
- 仓库快照不完整时不生成 Evidence，不启动 Agent，也不产生项目状态或总结写入；
- Agent 输出必须通过 JSON Schema 校验，失败则使用确定性兜底；
- `read_commit_details` 返回统一包含 `status`、`summary`、`next_actions`、`artifacts`、`data` 和 `budget`。

`evidenceDigest` 只覆盖语义输入：schema version、规范化仓库名、业务日期以及排序后的 Commit SHA/时间/标题。它明确排除 `run_id`、抓取时刻和项目引用。共享仓库总结必须保持项目无关，Agent prompt 不再包含项目 ID 或项目名；如果未来确实需要项目语境，则改为项目级缓存并取消跨项目复用。

缓存 identity 包含：

```text
evidenceDigest
+ evidence schema version
+ prompt content hash / prompt version
+ provider / model / model parameters / model catalog version
+ tool policy version
+ candidate selection policy version
+ detail/file/patch budgets
```

## 4. 并发总模型

首期生产推荐值：

| 资源池 | 进程级并发 | 队列上限 | 说明 |
| --- | ---: | ---: | --- |
| 活跃 OA run | 1 | 0 | 当前 Worker 完成 run 前不再 claim |
| OA Heartbeat | 1 | 1 | 保留控制面通道，不被数据请求阻塞 |
| OA 非 Heartbeat 总请求 | 4 | 数据面 200 + P0 保留 1 | 所有 OA 读取、业务写入、审计和 Trace 的父级上限；P0 不与数据面争等待槽 |
| OA 项目读取 | 4 | 100 | 列表分页串行；优先直接使用列表字段，兼容模式详情最多并发 4 |
| OA 业务写入 | 1 | 100 | 状态、总结、run project、AI interaction、run 终态串行 |
| OA Trace | 1 | 100，按 `event_key` 合并 | 共享 OA 非 Heartbeat 总池，低优先级 |
| GitHub HTTP | 6 | 200 | 仓库扫描和 Agent Commit 详情共享同一池 |
| 单仓库 GitHub HTTP | 1 | 1 | 分支和分页按仓库串行，避免热点仓库突发 |
| Codex Thread | 2 | 100 | 每个活跃仓库一个 Thread |
| 单 Thread Commit 详情 | 1 | 0 | 禁止同一 Thread 并发读取多个 Patch |
| SQLite 写入 | 1 | 100 | 单写者，事务尽量短 |

OA 使用一个原子准入的优先级调度器，而不是让调用方嵌套获取多个普通 Semaphore：

```text
heartbeatLimiter(1)                 # 独立保留，不与数据面竞争

OaRequestScheduler(total=4)         # 单次原子准入
├── P0 finalization/control         # lane cap 1
├── P1 fenced business/audit write  # lane cap 1
├── P2 read                         # lane cap 4
└── P3 trace                        # lane cap 1

mutationGroup(P0, P1)=1             # 所有控制/业务写入合计最多一个 in-flight
reservedP0Mailbox=1                 # 不计入数据面 200 个等待项
```

调度器一次性判断总容量、lane cap、跨 lane mutation group 和优先级，不允许持有父 permit 再等待子 permit，也不允许调用路径采用不同获取顺序。retry backoff 必须先释放 permit。P0 使用独立的单槽 control mailbox：即使数据面 200 个等待项已满仍可准入；同一 run 的重复终态请求按 idempotency key 合并。P0/P1 可越过尚未开始的 P2/P3 等待项；为避免普通读取永久饥饿，除 P0 finalization 外使用带最大等待时间的 weighted fairness。这样常规 OA 请求最多 4 个，P0/P1 合计最多 1 个，Heartbeat 最多额外 1 个，单 Worker 对 OA 的理论峰值为 5。

### 4.1 为什么保留 `6/2/1`

- GitHub `6`：读取阶段主要是网络等待，6 个并发请求能覆盖延迟，同时远低于常见连接和 secondary rate limit 风险区间；
- Agent `2`：模型通常是总耗时和内存瓶颈，当前容器 `2 CPU / 3GB` 下以 2 个隔离 Codex 进程起步更稳妥；
- OA 业务写入 `1`：状态和总结存在顺序、人工修改保护和冲突协调，串行写入便于保持幂等语义。

这些值是单 Worker 进程上限，不是集群上限。部署 `W` 个副本时，最坏峰值为：

```text
GitHub HTTP <= 6 * W
Codex Thread <= 2 * W
OA requests <= 5 * W
OA business writes <= 1 * W
```

在没有 OA 服务端 single-flight/fencing、分布式限流器和共享幂等存储前，`project-progress-worker` 副本数固定为 1。共享 SQLite 文件不构成业务 fencing。

## 5. 各接口并发、超时与重试策略

### 5.1 OA 自动化控制面

| 接口 | 并发 | 超时 | 重试 | 失败处理 |
| --- | ---: | ---: | --- | --- |
| `POST /internal/automation-job-runs/claim` | 1/Worker | 15s | 现契约不重试响应未知；支持 `claim_request_id` 后同 ID 总尝试最多 2 次 | 无任务 204 正常等待；活跃 run 未完成时不得再次 claim |
| `PATCH /internal/automation-job-runs/{run_id}` 标记 running | 1，P0 | 15s | 仅在 OA 明确同 payload 幂等后总尝试最多 3 次 | 未确认 running 不启动业务读取 |
| `POST .../{run_id}/heartbeat` | 1，独立通道 | 10s 建议 | 仅在租约剩余时间允许时总尝试最多 2 次 | 409 lease lost 立即取消；连续失败不得继续写 OA |
| `PATCH .../{run_id}` 终态 | 1，P0 | 15s | 同一终态 payload 总尝试最多 3 次 | 内容冲突 409 停止，不改写另一终态 |

Heartbeat 规则：

- 租约 300 秒、发送间隔 60 秒保持不变；
- Heartbeat 到期预算按 OA 返回的 `lease_expires_at` 计算，不只依赖本地定时器；
- 保持最多一个 Heartbeat in-flight；
- 当前请求仍在执行时跳过本次 tick，不累积多个 Heartbeat；
- 当 `now >= lease_expires_at - 30s` 且仍无法成功续租时，中止所有排队和在途 Agent 工作并停止业务写入；
- Heartbeat、取消检查和租约错误优先级高于 Trace。

取消和终态使用三个不同的信号：

- `workAbortSignal`：收到用户取消、deadline 预算不足时取消 OA/GitHub 读取、Agent、排队任务和项目 mutation；
- `leaseFatalSignal`：OA 明确返回无效/过期租约，或按 OA 时钟和安全余量判定租约已经不可恢复时触发；一旦触发，禁止一切 OA 上报；
- `finalizationSignal`：用户取消后仍保持有效，用于有界 Trace drain 和 `cancelled`/其他终态 PATCH；它受 leaseFatal 和 deadline 共同约束。

正常完成或用户取消后的终态使用明确硬截止时间：

```text
finalizationDeadline = min(deadline_at, lease_expires_at - 30s)
terminalReserve = 60s  # 最多 10s 等待在途 Heartbeat + 3 * 15s 终态尝试 + 5s backoff
prePatchBudget = max(0, finalizationDeadline - now - terminalReserve)
mutationQuiesceBudget = min(5s, prePatchBudget)
traceDrainBudget = min(3s, max(0, prePatchBudget - mutationWaitElapsed))
```

1. 触发 `workAbortSignal`，调度器拒绝新的 P1/P2 工作和新的 Trace 入队，只允许已有 Trace 进入有界 drain；等待业务 mutation 最多 `mutationQuiesceBudget`，不得无限等待；
2. 仍有未知在途 mutation 时不依赖本地等待保证安全，终态 OA 事务作为 barrier 与其串行裁决，并使旧 token/fence 失效；
3. Heartbeat 在前置收敛期间继续保护租约；进入终态 PATCH 前停止调度新 Heartbeat，等待唯一在途 Heartbeat 最多 10 秒，再用最新 OA 时间重算预算；
4. 只有在完整保留 `terminalReserve` 后仍有余额时，才按 `traceDrainBudget` drain/聚合 Trace；预算不足直接跳过 Trace；
5. 通过 P0 保留槽立即发送终态 PATCH，所有排队、backoff 和 HTTP 请求都受 `finalizationSignal` 与 `finalizationDeadline` 约束；
6. 终态确认后销毁 `run_mutation_token`；若 `leaseFatalSignal` 已触发则不发送终态。

租约时间判断以 OA 响应时间为准，并根据 `heartbeat_at` 或 HTTP `Date` 估算本地时钟偏差；本地时钟只作为保守下界。definitive lease loss 后不再尝试上报 cancelled 或 failed。

### 5.2 OA 项目同步读取

| 接口 | 并发 | 超时 | 重试 | 备注 |
| --- | ---: | ---: | --- | --- |
| `GET /internal/project-sync/projects?page&size` | 1 | 15s | 网络、408、429、5xx 总尝试最多 3 次 | `size=100`；页间串行，按项目 ID 去重 |
| `GET /internal/project-sync/projects/{project_id}` 发现阶段 | 默认不调用；兼容模式 4 | 15s | 同上 | 列表已经含 `id/name/status/github_urls`；只有未来契约把必要字段移出列表时才启用 |
| 同接口写前复核 | 1 | 15s | 同上 | 与业务写入同一项目临界区，复核状态和 GitHub URL 集合 |
| `GET /internal/project-sync/github-commit-summaries` | 1 | 15s | 同上 | 写前查询，按 `project_id + summary_date` 精确读取 |
| `GET .../github-commit-summaries/{summary_id}` | 1 | 15s | 同上 | 只用于响应缺字段或超时后的协调读取 |

项目列表使用 page/size 而非游标，分页期间项目可能变化。目标态消除当前发现阶段 N+1：直接使用列表中的 `id/project_name/status/github_urls` 建立候选仓库，只在业务写前读取详情。这样减少 `P` 次 OA 请求，同时仍由写前复核保护正确性。因此：

1. 每页 schema 校验；
2. 按项目 ID 去重；
3. 发现阶段以列表中的状态和 `github_urls` 为准；仅在兼容模式启用详情读取，并以详情字段覆盖列表字段；
4. 写前读取详情，并以该响应作为 mutation 的最终状态、仓库集合和 version 依据；
5. 中长期优先让 OA 提供带 `snapshot_at` 或 cursor 的同步接口，不通过提高分页并发掩盖一致性问题。

### 5.3 OA 业务写入和审计

| 接口 | 并发 | 是否可直接重试 | 协调方式 |
| --- | ---: | --- | --- |
| `PATCH /internal/project-sync/projects/{project_id}/status` | 1，P1 | 超时后不可盲重试 | OA 原子校验 lease fencing + `expected_version`；响应未知时重读并协调 |
| `POST /internal/project-sync/github-commit-summaries` | 1，P1 | 超时或 409 后不可盲重试 | 使用 idempotency key；按 `project_id + summary_date` 查询并协调 |
| `PATCH .../github-commit-summaries/{summary_id}` | 1，P1 | 超时后不可盲重试 | OA 原子校验 lease fencing + `expected_version`；响应未知时重读并协调 |
| `PUT .../{run_id}/projects/{project_id}` | 1，P1 | 可以，总尝试最多 3 次 | token/fence 校验；`(run_id, project_id)` 幂等 |
| `POST .../{run_id}/ai-interactions` | 1，P1 | 可以，总尝试最多 3 次 | token/fence 校验；`(run_id, interaction_key)` 幂等 |
| `POST .../{run_id}/trace-events` | 1，P3 | 可以，总尝试最多 2 次 | token/fence 校验；按 `event_key` upsert；失败不阻断业务 |

业务写入顺序：

1. 写前重读项目和当日总结，确认项目未归档、仓库集合未变化，取得各资源 version；
2. 构造该项目完整的业务 mutation group，包括状态更新和“确保当日总结”的 reconcile command，并生成稳定 idempotency key 与 payload hash；
3. 在一个本地 SQLite 事务中把整组记录及依赖顺序写为 `ready`，事务提交前不得发出任何远端 mutation；如需更早记录意图，只能写 `draft`，dispatcher 永远不发送 `draft`；
4. dispatcher 按顺序发送携带 scoped token、fencing 和 expected version 的 `ready` 记录；
5. 取得实际业务结果后，构造 run project 和 AI interaction 审计 payload，各自在发送前持久化为 `ready`，再写 OA；
6. 所有项目完成后通过 P0 写 run 终态。

outbox 使用 `draft -> ready -> in_flight -> acked` 状态机。启动恢复先用已持久化的 `claim_request_id + worker_id + 请求摘要` 重取同一 run 的 scoped token，再处理 `ready/in_flight`；只有 token、lease 和 fence 仍有效才允许重发，已失效时只做只读协调。OA mutation 事务的判断顺序固定为：验证 scoped token/当前 lease/fence -> 按 `idempotency_key + payload_hash` 查找已完成结果 -> 已存在则返回原结果，不再执行 CAS -> 不存在才校验 `expected_version` 并应用写入。相同 key 不同 payload 返回 409，不能凭资源内容恰好相同推断本次请求成功。

这里明确选择“业务 mutation 完成后再写 run project/audit”，因为 run project 的 `status_after` 和 `mutations_applied` 必须反映实际结果。当前集成文档中相反的推荐顺序需要在 Step 0 修正。若产品要求先展示项目运行记录，则先 PUT 一条 `pending` run project、业务完成后再幂等更新，但不能提前声称 mutation 已生效。

Trace 不加入业务写入顺序。它进入低优先级队列，同一个 `event_key` 的多个 `running` 更新只保留最新一条，终态事件不得被运行中事件覆盖。具体可靠性语义为 best effort，而不是“绝不丢失”：

- 内存队列最多 100 条，生产者只调用非阻塞 `tryEnqueue`，不得同步写 SQLite；
- SQLite spool 默认最多 10000 条、20 MiB、TTL 24 小时，三者任一达到即执行合并/丢弃策略；默认值均可配置但不得设为无界；
- spool 由独立 worker thread 或异步 SQLite 驱动的后台单写者批量落盘，每批最多 100 条或每 100ms flush 一次，不能在主事件循环执行同步磁盘写；
- 队列或 spool 饱和时先合并/丢弃中间 `running`，再把无法保留的事件计数聚合到 `trace_delivery_summary`；
- run 终态 PATCH 前最多 drain 3 秒；未投递明细记录到本地指标和结构化日志，不阻塞终态；
- run 进入终态后不承诺补写 Trace，清理该 run 的过期 spool；
- Trace publish 不再被并发 Agent 直接 await 网络请求。

### 5.4 GitHub REST

| 接口 | 全局并发 | 单仓库并发 | 超时 | 重试 |
| --- | ---: | ---: | ---: | --- |
| `GET /repos/{owner}/{repo}` | 6 | 1 | 20s | 网络、408、429、500/502/503/504 总尝试最多 3 次 |
| `GET /repos/{owner}/{repo}/branches` | 6 | 1 | 20s | 同上；分页串行 |
| `GET /repos/{owner}/{repo}/commits` | 6 | 1 | 20s | 同上；每个分支分页串行 |
| `GET /repos/{owner}/{repo}/commits/{sha}` | 6 | 1/Thread | 20s | 同上；仍受详情调用和 Patch 预算限制 |

所有 GitHub 请求必须共享同一个 token 级 limiter，不能为仓库扫描和 Agent 工具各建一个并发 6 的池。状态码策略：

- `401`：凭证配置错误，不重试，本 run 终止为 configuration error；
- `404`：仓库配置或权限问题，不重试，关联项目标记 incomplete；
- `409`：空仓库 Commit 列表按空结果处理；
- `422`：请求参数或 SHA 问题，不重试；
- `429`：优先遵循 `Retry-After`；
- `403`：仅在响应带 rate limit/secondary rate limit 信号时等待，否则按权限错误处理；
- `5xx`/网络错误：指数退避加 full jitter，建议基数 `500ms`，上限 `8s`，最多 3 次。

自适应降载：

- `x-ratelimit-remaining / x-ratelimit-limit > 20%`：并发 6；
- 剩余比例 `10%-20%`：并发降为 3；
- 剩余比例 `<10%`：并发降为 1；
- 收到 secondary rate limit：暂停新请求，按 `Retry-After` 恢复；没有该头时从 30 秒开始退避；
- 连续 5 分钟无 rate limit 后逐级恢复 `1 -> 3 -> 6`，禁止立即跳回 6。

降低并发只能减少突发，不能减少 primary rate limit 的总请求量。token 级 executor 还必须实现 reset-aware pacing 和请求预算：

- 保留 `max(100, 10% * limit)` 请求不分配给本 run；
- 根据 `(remaining - reserve) / seconds_to_reset` 计算 token bucket 补充速率；
- 必需的仓库扫描优先于可选 Commit 详情；
- 扫描完成后，按剩余预算和活跃仓库数公平分配详情调用额度；预算不足时允许 Agent 只依据标题总结并声明 limitation；
- 达到 run 请求预算时停止扫描新仓库，将未完成项目标记 incomplete 并按 `reset_at` 建议重试。

为防止单个巨型仓库拖垮 run，新增可配置硬上限：单仓库最大分支数、单分支最大 Commit 页数、单仓库最大 GitHub 请求数。超过上限不得静默截断为完整数据，而是将该仓库标记 incomplete。默认值要通过 Step 1 基准确定，不能凭空固化。

现有 `AsyncSemaphore` 不支持运行时调整并发，因此 Step 3 必须交付暂停闸门、固定并发和请求预算；Step 4 再交付 `6/3/1` 可变容量与逐级恢复，两个阶段都有独立验收。

### 5.5 模型与 Agent

| 操作 | 并发 | 超时 | 重试/降级 |
| --- | ---: | ---: | --- |
| 单仓库 Codex Thread | 2 | 180s | 只有确认请求未被上游接受时才允许重试 1 次；其他失败直接确定性兜底 |
| 单 Thread `read_commit_details` | 1 | 30s | 由 GitHub 策略处理；工具错误作为 limitation 返回 |

Agent 约束保持：

- 每个 `repository + businessDate` 最多一个 Thread；
- 候选 Commit 默认最多 50 条；
- 详情调用默认最多 12 次；
- 每条最多返回 20 个文件、单文件 1200 Patch 字符、单仓库总计 12000 Patch 字符；
- 禁用 shell、文件系统、网页、额外 MCP、插件和多 Agent；
- 未授权工具调用、输出 schema 失败或输出过程性文字时拒绝结果并确定性兜底；
- 整个 Thread 不因普通输出质量问题自动重跑，避免双倍费用和非确定性放大；
- 缓存使用第 3 节定义的完整 cache identity，重试 run 优先复用已成功结果。

模型 limiter 按 `provider + credential identity` 建立，而不是只按 Worker 建立：

- Worker 使用项目进度专用 provider credential；如果与交互 Agent 共用 credential，必须通过 provider gateway 或 Redis 使用共享 RPM/TPM/并发配额；
- 每个 provider 配置并发、RPM、TPM、单 run token 和成本预算；默认并发仍为 2；
- 连续 3 次 429/5xx 打开 60 秒熔断，之后只允许一个 half-open 探测；deadline 不允许等待时直接兜底；
- 只有 `upstreamRequestId=null`、usage 为 0、工具调用为 0，且错误明确表示请求未被接受时才允许一次短重试；Codex SDK 无法提供这些证据时不重试整个 Thread；
- NextToken 和 OpenRouter 分别做限流、错误分类和恢复验证，不能用同一个 fake provider 测试代替。

超过 50 条候选 Commit 时使用有版本号的确定性选择策略，并把策略版本放入 cache identity。首版建议按提交时间和 SHA 稳定排序后保留最早 25 条与最晚 25 条；不得直接依赖上游返回顺序。

## 6. 背压和任务调度

不要一次为所有项目和仓库创建无限量 Promise。使用有界生产者/消费者队列：

1. OA 列表逐页产生项目 ID；
2. 默认不创建发现阶段详情任务；兼容模式下详情池最多 4 个活跃请求、100 个等待项；
3. 规范化仓库写入按 `owner/repo` 去重的 work map；
4. GitHub 仓库队列最多 200 个等待项，超过后暂停消费 OA 项目页；
5. 所有仓库快照完成后再决定 Agent 任务，保持“任一关联仓库不完整则项目不写”的安全屏障；
6. Agent 队列最多 100 个等待项，生产者按仓库名稳定排序；
7. OA 写入按项目 ID 稳定排序，单写者执行；
8. 用户取消或 deadline 临近时通过 `workAbortSignal` 停止生产和业务任务；只有 definitive lease loss 才触发 `leaseFatalSignal` 并禁止 finalization。

当前不建议把 GitHub 读取与 Agent 总结完全流水化。先完成仓库快照屏障，可以避免关联项目有仓库读取失败时仍花费模型成本；当仓库规模证明该屏障成为瓶颈后，再评审以项目完整性为单位的小批量流水线。

## 7. 容量估算和调参方法

设：

- `P`：非归档项目数；
- `R`：唯一仓库数；
- `A`：当天活跃、需要 Agent 的唯一仓库数；
- `Qgh`：本 run GitHub HTTP 请求总数；
- `Woa`：OA mutation 和审计写入总数；
- `Lx`：对应接口 p95 延迟。

粗略运行时间下界：

```text
T_oa_read  ~= pageCount * L_oa_list + projectsWritten * L_oa_prewrite_read
T_github   ~= (Qgh / 6) * L_github，且受单仓库串行分页约束
T_agent    ~= ceil(A / 2) * L_agent_thread
T_oa_write ~= Woa * L_oa_write
T_total    ~= T_oa_read + T_github + T_agent + T_oa_write
```

Agent 通常是瓶颈。只有同时满足以下条件才把 Agent 并发从 2 提升到 3：

- 连续 5 个工作日 Agent 队列等待 p95 超过 5 分钟；
- 模型 429 比例低于 1%；
- 容器内存峰值低于限制的 70%；
- CPU p95 低于 70%；
- GitHub secondary rate limit 为 0；
- OA run 可在 `deadline_at` 前至少预留 5 分钟完成写入。

GitHub 并发只在请求 p95 高且 rate limit 充足时上调；最大仍限制为 10，不能直接使用配置允许的 20。OA read 并发只有在 OA 端确认容量后从 4 调到 6，业务写入始终为 1。

## 8. 可观测性与告警

每个资源池记录：

- `active`、`pending`、`peak_active`；
- queue wait p50/p95/max；
- 请求次数、成功次数、重试次数；
- timeout、429、5xx、contract error 数量；
- endpoint latency p50/p95；
- 取消时被拒绝的等待任务数。

额外记录：

- GitHub `rate_limit`、`remaining`、`reset_at` 和 secondary limit 次数；
- Agent 每仓库耗时、token、详情调用数、fallback 比例；
- 各 provider/API-key 的 RPM、TPM、429/5xx、熔断状态和单 run 成本；
- Trace 合并数、丢弃的中间事件数、最终事件投递失败数；
- Heartbeat 距离 lease expiry 的最小安全余量；
- 每个阶段耗时：OA discovery、GitHub read、Agent、fan-in、OA write/audit。

建议告警阈值：

- Heartbeat 安全余量低于 60 秒；
- GitHub 429/secondary limit 任意出现；
- Agent fallback 比例超过 10%；
- OA 业务写入 p95 超过 3 秒或连续 3 次 5xx；
- run 剩余 deadline 少于 5 分钟但尚未进入写入阶段；
- 任一有界队列达到容量 80% 持续 1 分钟。

## 9. 实施步骤与依赖关系

```text
Step 0 OA fencing、条件写与单活跃 run 契约
  -> Step 1 基线与契约冻结
      ├── Step 2 OA 原子调度器、重试与 Trace 背压
      └── Step 3 GitHub 固定并发、请求预算与暂停闸门
              -> Step 4 GitHub 自适应容量与模型 provider 配额
                  Step 2 + Step 4
                    -> Step 5 Evidence DTO 与 Agent 边界固化
                        Step 0 + Step 2 + Step 5
                          -> Step 6 幂等写入、outbox 恢复和端到端取消
                              -> Step 7 压测、灰度和默认值固化
```

Step 2 与 Step 3 可以并行开发。其他步骤按依赖顺序执行。

Git 和 GitHub CLI 当前可用，默认分支为 `origin/main`。每步使用独立 PR：

| Step | 建议分支 | PR 边界 | 依赖 |
| --- | --- | --- | --- |
| 0 | `mikoe33/project-progress-oa-fencing-contract` | OA 契约、客户端兼容层、接口文档 | 无 |
| 1 | `mikoe33/project-progress-concurrency-baseline` | 基准、指标、正确性回归 | Step 0 |
| 2 | `mikoe33/project-progress-oa-scheduler` | OA 原子调度器、Trace spool、信号拆分 | Step 1 |
| 3 | `mikoe33/project-progress-github-budget` | GitHub executor、固定并发、预算和硬上限 | Step 1 |
| 4 | `mikoe33/project-progress-adaptive-quotas` | GitHub 动态容量、provider 配额和熔断 | Step 3 |
| 5 | `mikoe33/project-progress-evidence-contract` | Evidence、canonical digest、Agent 输入边界 | Step 2、4 |
| 6 | `mikoe33/project-progress-fenced-outbox` | fenced mutation、outbox replay、缓存、crash recovery | Step 0、2、5 |
| 7 | `mikoe33/project-progress-concurrency-rollout` | 压测、部署门禁、配置与运维文档 | Step 6 |

### Step 0：OA fencing、条件写与单活跃 run 契约

上下文：项目同步 mutation 当前只携带服务 token，本地取消无法撤回已经到达 OA 的旧 Worker 请求。该步骤是扩大并发、自动接管和可靠重试的前置条件。

实施进展（2026-08-07）：Worker 已实现持久化 claim identity、兼容 claim 解码、scoped mutation 字段、稳定幂等键、`expected_version`、明确 lease/fence 失效后的立即停止，以及 CI 黑盒门禁。OA 服务端的 HMAC、事务 fencing、CAS、single-flight 和测试环境证据仍是外部依赖；门禁通过前 Step 0 不得标记完成，也不得扩大 Worker 副本数。

任务：

- Worker 在首次 claim 前持久化 request ID、稳定 worker ID 和请求摘要；OA 幂等窗口覆盖最大 run 时长与恢复宽限期，不同请求复用同 ID 返回 409；
- 使用服务端 HMAC 确定性派生 scoped `run_mutation_token`，使同一 claim 可安全重放而无需保存 raw token；claim 同时返回单调 fencing token；
- 增加独立 `concurrency_key`；本任务按 `tenant_id + job_type + all_projects` single-flight，不以 `job_key` 作为写入互斥边界；
- 项目和总结读取稳定返回 version；
- 所有 run-scoped mutation 接收 `run_id + run_mutation_token + fencing_token + idempotency_key`，资源更新再接收 `expected_version`；
- OA 在一个事务内验证 token scope、租约和 fencing，先按 key + payload hash 协调已完成结果，再对首次写入执行 version CAS；
- 明确 running/终态同 payload 重放契约，并让终态事务成为使旧 token/fence 失效的服务端 barrier；
- 先发布 OA 向后兼容接口，再发布 Worker 双读/新写客户端，最后将 fencing 字段改为必填；
- 更新 `docs/oaagent_integration_api.md`，纠正业务 mutation、run project、AI audit、终态的目标顺序。

验证：

```bash
npm exec -w agent -- tsx --test test/openApiContract.test.ts
npm exec -w agent -- tsx --test test/automationOaClient.test.ts
npm exec -w agent -- tsx --test test/projectProgressOaClient.test.ts
OA_FENCING_TEST_BASE_URL="$OA_FENCING_TEST_BASE_URL" npm exec -w agent -- tsx --test test/oaFencingIntegration.test.ts
```

在本仓库 `.github/workflows/ci-cd.yml` 增加部署门禁 job `oa-fencing-contract`，对 OA 测试环境执行上述黑盒测试，并记录 `oa_backend_commit_sha` 与 OA 后端 CI 证据 URL；缺少任一证据不得完成 Step 0。OA 后端仓库仍需运行自身 migration、事务并发和数据库锁测试，不能只用 Agent mock 代替。

必须增加 OA 集成测试：旧 token/fence 写入返回 409；version 不匹配返回 409/412；相同 idempotency key + payload hash 不重复生效；相同 key 不同 payload 返回 409；claim 响应丢失后同 request ID 返回同一 token；同 ID 不同请求返回 409；两个 Worker 使用不同 `job_key` 但相同 `concurrency_key` 时只有一个能获得活跃 run；cron/manual/retry 组合也遵守同一 writer scope。

退出标准：服务端证据证明旧 Worker mutation 不会生效，Worker 才能把“租约丢失后无新业务 mutation”作为强保证。

回滚：OA 先保留旧字段的兼容读取但关闭新 Worker claim；数据库字段只做向后兼容扩展，不在同一发布中删除旧字段。fencing 一旦成为安全依赖，不允许仅回滚 Worker 而绕过 OA 校验。

### Step 1：基线与契约冻结

上下文：当前代码已经实现主要业务链路，但缺少逐接口延迟、重试和排队指标。先固定可比较的 baseline，避免并发调整只有主观判断。

实施进展（2026-08-07）：已增加稳定逻辑 endpoint、请求成功/失败与延迟分位数、Agent 排队时间，以及可重复的本地 fake-server 基线。`P=100、R=50、A=20` 固定产生 OA 101 次、GitHub 150 次和模型 20 次逻辑请求，并验证 GitHub/Agent 峰值 `6/2`。样本环境与结果归档在 `plans/baselines/project-progress-step1-baseline-2026-08-07.md`。归档跳过、共享仓库去重、不完整快照不生成总结或水位、租约取消、稳定幂等写入均已有回归测试。Step 0 OA 服务端门禁仍未通过，因此这不授权扩大 Worker 副本数或启用并发写接管。

任务：

- 为 OA、GitHub、模型请求增加统一 endpoint 名称和计时接口；
- 使用 fake server 构造 `P=100、R=50、A=20` 的基准场景；
- 记录当前运行时间、峰值并发、请求总数、Agent 队列时间和内存；
- 固定当前正确性测试：归档跳过、共享仓库去重、不完整项目不写、租约取消、写入幂等。

验证：

```bash
npm exec -w agent -- tsx --test test/syncProjectProgress.test.ts
npm exec -w agent -- tsx --test test/projectProgressOaClient.test.ts
npm exec -w agent -- tsx --test test/githubClient.test.ts
npm exec -w agent -- tsx --test test/runProjectProgressAutomation.test.ts
npm run typecheck -w agent
```

退出标准：基准数据可重复运行；现有业务不变量均有测试覆盖。

回滚：只移除指标包装和基准 fixture，不修改业务行为。

### Step 2：OA 原子调度器、重试与 Trace 背压

上下文：OA 项目详情串行读取，Trace 可被两个 Agent Thread 并发触发，而 Heartbeat 必须拥有独立的租约安全路径。

任务：

- 实现单个原子 `OaRequestScheduler`，支持总容量、lane cap、`mutationGroup(P0,P1)=1`、P0 保留 mailbox、优先级和最大等待时间；
- Heartbeat 使用独立 limiter，保持最多一个 in-flight；
- 默认直接使用项目列表字段，删除发现阶段 N+1；兼容模式详情读取有界并发 4；
- 增加 OA GET 的分类重试；
- 为业务 mutation 实现 read-after-timeout 协调，不做盲重试；
- 本步骤新增的 OA queue wait、retry backoff、Trace drain 和在途 HTTP 全部立即接收对应 AbortSignal，不推迟到后续步骤；
- 增加按 `event_key` 合并的 Trace 有界队列、非阻塞 `tryEnqueue`、后台 SQLite spool 单写者、聚合丢弃计数和有界 drain；
- 拆分 `workAbortSignal`、`leaseFatalSignal`、`finalizationSignal`；
- 确保 run project、AI interaction 和 run 终态也纳入业务写入并发 1。

验证：

```bash
npm exec -w agent -- tsx --test test/asyncSemaphore.test.ts
npm exec -w agent -- tsx --test test/projectProgressOaClient.test.ts
npm exec -w agent -- tsx --test test/automationOaClient.test.ts
npm exec -w agent -- tsx --test test/runProjectProgressAutomation.test.ts
npm exec -w agent -- tsx --test test/syncProjectProgress.test.ts
```

退出标准：OA 非 Heartbeat 峰值不超过 4，Heartbeat 峰值不超过 1，P0/P1 业务写入合计峰值为 1；数据等待队列和所有 lane 填满时 P0 仍能进入保留槽；取消可中止 OA 排队、backoff 和在途请求；finalization 遵守 60 秒终态保留预算；Trace 洪峰下队列/spool 有界且事件循环延迟 p95 低于 50ms。

回滚：关闭兼容模式详情池、OA GET 分类重试和 Trace 异步投递，恢复默认列表发现与同步 Trace；保留 Heartbeat 独立通道及三类 AbortSignal，业务写入继续串行。

### Step 3：GitHub 固定并发、请求预算与暂停闸门

上下文：仓库扫描和 Agent Commit 详情已共享 limiter，但当前只报告 rate limit，没有安全重试、暂停闸门和恢复规则。

任务：

- 把所有 GitHub 请求统一通过 token 级 request executor；
- 增加状态码分类、`Retry-After`、full-jitter backoff；
- 增加单仓库串行 limiter和单仓库分支/页数/请求硬上限；
- 增加 secondary rate limit 暂停闸门；
- 增加 reset-aware token bucket、run 请求预算和详情预算分配；
- GitHub queue wait、retry/backoff、`Retry-After`、暂停闸门和在途 fetch 在本步骤接收 `workAbortSignal`；
- 记录 rate limit headers 和队列指标；
- 首期保持固定并发 6，动态容量由 Step 4 交付。

验证：

```bash
npm exec -w agent -- tsx --test test/githubClient.test.ts
npm exec -w agent -- tsx --test test/projectProgressGithubMcp.test.ts
npm exec -w agent -- tsx --test test/syncProjectProgress.test.ts
```

退出标准：测试证明扫描与 MCP 的总 HTTP 并发不超过 6；429、rate-limited 403 和 5xx 按策略重试，401/404/422 不重试；预算或单仓库上限耗尽时结果为 incomplete 而非静默截断；取消能立即打断排队、退避、暂停等待和在途请求。

回滚：关闭请求预算、暂停闸门和新增重试，恢复现有固定并发 6；保留统一 request executor 的指标包装以便定位问题。

### Step 4：GitHub 自适应容量与模型 provider 配额

上下文：固定并发和暂停闸门控制突发，但不能根据配额余量恢复容量，也不能约束与其他服务共享的模型 API key。

任务：

- 实现 GitHub limiter 的 `6/3/1` 动态容量和逐级恢复；
- 容量调整与 reset-aware pacing、run 请求预算共同工作；
- 为 NextToken/OpenRouter 分别配置 provider + credential identity 级并发、RPM、TPM、token 和成本预算；
- Worker 改用专用 provider credential；共用 credential 时接入共享 quota gateway；
- 实现 429/5xx 熔断、half-open 探测和无证据不重试规则；
- provider limiter wait、RPM/TPM 等待、熔断 cooldown、half-open 等待和模型请求在本步骤接收 `workAbortSignal`；
- 增加两个 provider 的错误分类、配额和恢复集成测试。

验证：

```bash
npm exec -w agent -- tsx --test test/githubClient.test.ts
npm exec -w agent -- tsx --test test/projectProgressAgentSummarizer.test.ts
npm exec -w agent -- tsx --test test/projectProgressConfig.test.ts
```

退出标准：GitHub 可按配额从 6 降到 3/1 并逐级恢复；两个 provider 均不会超过配置配额；无法证明上游未接受的模型调用不自动重试；取消不会继续等待 quota、cooldown 或 half-open。

回滚：关闭动态容量并回到 Step 3 的固定并发 6 + pacing/request budget；provider limiter 和专用 credential 不回滚。

### Step 5：Evidence DTO 与 Agent 边界固化

上下文：当前边界已经接近目标，但需要显式 schema/version，避免 OA/GitHub 上游字段变化直接进入提示词。

任务：

- 引入 `RepositoryEvidence` 和 schema version；
- 在代码层完成字段白名单、稳定排序、裁剪和 digest；
- 从共享仓库 Agent 输入中移除项目 ID、项目名、run ID 和抓取时刻；
- Agent prompt 只接收 Evidence DTO；
- MCP 只允许 Evidence 中的仓库和 SHA；
- 输出 schema 继续限制为总结和 limitations；
- 增加 prompt injection、超长标题、重复 SHA、非法 URL 和不完整响应测试。

验证：

```bash
npm exec -w agent -- tsx --test test/githubUrl.test.ts
npm exec -w agent -- tsx --test test/projectProgressAgentSummarizer.test.ts
npm exec -w agent -- tsx --test test/projectProgressGithubMcp.test.ts
npm exec -w agent -- tsx --test test/syncProjectProgress.test.ts
```

退出标准：Agent 无法决定接口、参数、仓库集合、业务日期、项目状态或写入内容；同一证据产生稳定 digest。

回滚：保留现有 summary input adapter，同时继续禁止 Agent 直接访问 OA 和通用 GitHub 工具。

### Step 6：幂等写入、outbox 恢复和端到端取消

上下文：本地 outbox 和 managed summary 已存在，但仓库级成功结果尚未形成完整缓存，outbox 还需要把预写校验、原子 ready 状态和 crash recovery 组合成端到端语义。

任务：

- 增加第 3 节定义的完整仓库总结 cache identity；
- 验证 Step 2-4 已分别接通的 AbortSignal 能跨 OA、GitHub、MCP、Agent 阶段组合传播，finalization 继续使用独立信号；
- run project 和 AI interaction 使用稳定幂等键重放；
- 项目 mutation 使用 OA fencing、idempotency key 和 expected version；
- 写前读取并取得 version 后，把同项目全部业务 mutation 及依赖顺序在一个 SQLite 事务中写为 `ready`；`draft` 永不发送；
- 实现启动时先用持久化 claim identity 重取内存态 scoped token，再由 outbox dispatcher/replay 发送有效 run 的 `ready/in_flight`，补齐 mutation 超时后的 read-after-write 协调；
- 验证 OA 按“当前 token/lease/fence -> idempotency key + payload hash -> 首次写入 CAS”的顺序协调重放；
- 增加 crash point：请求前、远端 ack 后本地 mark 前、状态后总结前、业务写后审计前、审计后终态前；
- 在 deadline 前保留至少 5 分钟写入预算，不足时停止启动新 Agent Thread；
- 验证人工修改总结不会被 Worker 覆盖。

验证：

```bash
npm exec -w agent -- tsx --test test/projectProgressStore.test.ts
npm exec -w agent -- tsx --test test/runProjectProgressAutomation.test.ts
npm exec -w agent -- tsx --test test/syncProjectProgress.test.ts
npm test -w agent
npm run typecheck -w agent
```

退出标准：run 重试只重做失败或输入变化的仓库；`draft` 和无有效 lease 的 outbox 记录永不发送；同项目不会在完整业务 mutation group 持久化前发生首个远端写入；租约丢失后无新的业务 mutation；远端 ack 后本地 mark 前崩溃不会造成重复总结或把成功误判为 version conflict。

回滚：通过 feature flag 禁用仓库缓存读取和新队列；SQLite migration 保持向后兼容，旧代码可忽略新表/列；不得回滚 OA fencing、expected version 和幂等保护。

### Step 7：压测、灰度和默认值固化

上下文：并发值必须由真实 OA、GitHub、模型和容器指标验证，不能仅依赖单元测试。

任务：

- 执行 `P=100/500`、`R=50/200`、`A=20/100` 的 fake-server 压测；
- 在测试环境先使用 `OA read=2、GitHub=3、Agent=1、write=1`；
- 确认 24 小时无限流和租约风险后切到目标 `4/6/2/1`；
- 连续 5 个工作日观测重复总结、人工覆盖、fallback、429、队列和资源峰值；
- 在 CI 和部署清单固定副本数 1，并增加双 Worker 负向测试；两个 Worker 即使使用不同 `job_key`，相同 `concurrency_key` 下第二个 claim 也必须为空；
- 若未来扩副本，先引入共享 quota gateway/Redis limiter 和共享幂等存储，再按集群总额度拆分进程额度；
- 将验证后的默认值同步到 `.env.example`、Compose、CI/CD 和运维文档。

验证：

```bash
npm test -w agent
npm run typecheck -w agent
npm run build -w agent
docker compose config
```

退出标准：连续 5 个工作日满足以下条件：无重复总结、无错误状态切换、无租约丢失、GitHub 429 为 0、Agent fallback 小于 10%、容器内存和 CPU p95 低于 70%。

回滚：按 `Agent 2 -> 1`、`GitHub 6 -> 3`、`OA read 4 -> 2` 顺序降载；业务写入始终保持 1。

## 10. 测试矩阵

| 场景 | 预期 |
| --- | --- |
| 100 个非归档项目 | 发现阶段无 N+1 详情请求；OA 非 Heartbeat 总峰值不超过 4 |
| 200 个唯一仓库 | GitHub HTTP 峰值不超过 6，等待队列有界 |
| 同仓库关联多个项目 | 仓库只扫描、总结一次，结果 fan-out |
| 20 个活跃仓库 | 20 个仓库任务，Codex Thread 峰值 2 |
| Agent 同时读取 Commit 详情 | 与扫描共享 GitHub 总池，峰值仍不超过 6 |
| Trace 高频更新/OA 长时间不可用 | 相同 event key 合并；中间事件可聚合丢弃；队列/spool 有界；Heartbeat 和终态不受阻塞 |
| GitHub 429 | 遵循 Retry-After，暂停新请求并逐级恢复 |
| GitHub 配额接近 reserve | 停止可选详情；达到 run budget 后剩余仓库 incomplete，不越过保留额度 |
| 巨型仓库超过分支/页数/请求上限 | 仓库 incomplete，不静默截断为 complete |
| GitHub 404 | 不重试，关联项目 incomplete，不写状态和总结 |
| OA GET 503 后恢复 | 总尝试最多 3 次后成功，记录 retry 指标 |
| OA create summary 超时但实际成功 | 查询后采纳，不重复 POST |
| OA summary 被人工修改 | 停止更新并报告 write conflict |
| claim 响应丢失 | 现契约不盲重试；新契约用相同 request ID 取得同一 claim |
| claim request ID 被不同请求复用 | OA 按 worker + 请求摘要 + TTL 检测并返回 409 |
| 两个不同 job key 写同一项目作用域 | `concurrency_key` single-flight，只允许一个活跃 run |
| 低优先级 Trace 占满等待队列 | P0 终态原子准入，无死锁且等待有界 |
| P0/P1 同时就绪 | `mutationGroup(P0,P1)` 保证业务和控制 mutation 合计并发 1 |
| 所有 OA lane 与总等待队列均满 | P0 使用保留 mailbox 准入，不被数据面队列容量拒绝 |
| Heartbeat 返回 cancel | work signal 取消业务任务，finalization signal 仍能上报 cancelled |
| Heartbeat 租约丢失 | lease fatal 立即停止；旧 fencing token 的在途 mutation 被 OA 拒绝 |
| 本地时钟偏差 | 使用 OA 时间与 RTT 安全余量，不越过 OA lease expiry |
| NextToken/OpenRouter 429 | 对应 credential limiter 降载/熔断，无证据不重跑 Thread |
| 分别在 OA/GitHub/provider queue、backoff、pause、cooldown 和在途请求时取消 | 对应步骤立即退出等待，不继续发起后续请求 |
| Worker run 重试 | 复用成功仓库缓存，幂等写回，无重复审计 |
| crash after outbox draft before prewrite validation | dispatcher 不发送 draft，无未校验 mutation |
| crash after ready group commit before first request | dispatcher 只在当前 lease/fence 有效时按依赖顺序恢复 |
| crash after remote ack before local mark | outbox replay 通过 idempotency key/read-after-write 协调，不重复生效 |
| Trace 洪峰与 SQLite 慢盘 | `tryEnqueue` 不阻塞，spool 保持在 10000 条/20 MiB/24h 内，事件循环延迟 p95 < 50ms |
| 启动两个 Worker | CI/部署策略保持单副本；即使误启动，OA single-flight 只发放一个活跃 run |

## 11. 非目标

- 不让 Agent 自行检索 OA OpenAPI、选择 endpoint 或构造分页参数；
- 不让 Agent 直接持有 OA token 或 GitHub PAT；
- 不 clone 仓库，不开放 shell 或文件系统；
- 不通过增加 Worker 副本绕过单进程并发限制；
- 不在首期引入项目级二次润色 Agent；
- 不以提高并发替代 cursor/snapshot、幂等键和 CAS 等服务端一致性能力。

## 12. 方案变更协议

任何并发默认值调整必须附带：

1. 调整前后 5 个工作日或等价压测数据；
2. GitHub rate limit、模型 429、OA 429/5xx、队列 p95、CPU 和内存对比；
3. 单 Worker 和部署副本数说明；
4. 回滚阈值和负责人；
5. 对幂等、取消、人工修改保护和租约安全的不变量验证结果。

如果新增接口或模型工具，先更新本计划的接口表、工具输入输出 schema、重试语义和总并发公式，再开始实现。

步骤状态使用 `proposed -> in_progress -> verified -> merged`；无法继续时标记 `blocked` 并记录外部依赖，方案被替代时标记 `superseded` 并链接新决策。

- 拆分步骤：新步骤继承原步骤依赖，只有各自退出标准独立可验证时允许拆分；
- 插入步骤：涉及安全契约、数据迁移或部署门禁时必须插在首个依赖它的步骤之前；
- 重排步骤：必须重新检查共享文件、接口发布顺序、数据库兼容和回滚路径；
- 跳过步骤：只能在退出标准已有等价证据时跳过，并在 PR 中链接证据；
- 调整并发：先灰度降低风险，再用指标证明可以提升；不能因为 deadline 紧张直接突破硬上限；
- 修改契约：OA 先向后兼容发布，Worker 再启用新字段，最后才允许 OA 收紧为必填。

## 13. 对抗审阅记录

2026-08-05 已完成两轮独立只读审阅。审阅提出的关键问题已纳入本版：

- OA 服务端 fencing、version 条件写和 claim 幂等提升为 Step 0；
- claim 在旧契约下禁止响应未知后的盲重试；
- 嵌套 Semaphore 改为原子优先级 OA scheduler；
- 工作取消、租约致命和 finalization 信号拆分；
- 单副本限制增加 OA single-flight、CI/部署门禁和双 Worker 负向测试；
- Trace 改为有界 best-effort + SQLite spool + 聚合丢弃计数；
- GitHub 固定预算与动态容量拆成独立步骤，并补充请求量预算和巨型仓库上限；
- 增加 provider/credential 级 RPM、TPM、成本预算和熔断；
- Evidence canonical digest 与缓存 identity 排除 run 易变字段并纳入完整语义版本；
- outbox dispatcher、crash-point、发布顺序、回滚兼容和可执行测试命令已补齐；
- claim 凭证明确为可确定性重发的 scoped HMAC token，并绑定 worker、请求摘要、TTL 和持有者证明；
- single-flight 从 `job_key` 提升为 `tenant + job type + writer scope` 的独立 concurrency key；
- OA scheduler 增加 P0/P1 跨 lane mutation group 和 P0 保留 mailbox；
- OA、GitHub 和 provider 新增的每一类等待都在所属步骤同步接入取消，不推迟到最终集成；
- outbox 改为写前校验后原子提交完整 `ready` group，并明确服务端 idempotency lookup 与 CAS 顺序；
- finalization 增加硬截止公式和 60 秒终态预算，Trace spool 增加非阻塞入队、默认容量与事件循环延迟验收。
