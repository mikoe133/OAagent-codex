# OA 只读数据库查询与语义元数据

配置 `DATABASE_URL_READ` 后，OA 对话的业务查询、搜索、统计、报表，以及写操作前定位/写后核验，使用只读数据库工具。OA 业务读取 API 在工具服务端被拦截，不能因为查询失败而回退到业务 GET 接口。写操作继续使用 OA API；知识库和外部资料路由不变。登录、身份和管理员校验仍使用 OA 的认证边界，不属于业务取数。

`DATABASE_URL` 是自动任务存储，`DATABASE_URL_READ` 是 OA 业务查询，两者不得混用。

## 配置和首次启动

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `DATABASE_URL_READ` | 空 | MySQL 只读 URL；用户名/密码中的特殊字符需 URL 编码 |
| `OA_READ_METADATA_PATH` | `agent/metadata/oa-read.json` | 版本化业务语义与访问规则 |
| `OA_READ_STATE_DIRECTORY` | `.context/oa-read` | 结构快照、发布版本和同步状态 |
| `OA_READ_SYNC_INTERVAL_SECONDS` | 300 | 后台自动检测表/字段变化，最低 60 秒 |
| `OA_READ_QUERY_TIMEOUT_MS` | 10000 | 单条查询超时，最高 30000 毫秒 |
| `OA_READ_MAX_ROWS` | 200 | 单页结果上限，最高 1000 |
| `OA_READ_CONCURRENCY` | 4 | 用户查询连接上限，无无限等待队列；结构同步另用 1 个连接 |

正常使用无需手动同步。Agent 启动时同步一次，之后默认每 5 分钟检查一次。无论通过数据库管理工具、手写 SQL 还是业务服务修改表结构，都会在后续检查时发现。

如需立即检查，可选用本地命令：

```bash
npm run sync:oa-metadata -w agent
```

镜像内同步：

```bash
node agent/dist/runtime/oaMetadataSync.js
```

该命令只读取数据库结构及验证可查询性，不创建表、视图或修改授权。无需模型 API key。服务启动会执行一次同步，然后按配置间隔检查。未配置连接时保留旧版 API 模式；配置后元数据未发布或验证失败会明确拒绝查询，而不会回退 API。

Compose 只给 Agent 服务注入只读连接，状态目录位于持久卷 `/app/.context/oa-read`。GitHub Actions 的对应 `test` / `production` Environment 需要配置 `DATABASE_URL_READ` Secret；不能用 Repository 级公共生产凭据覆盖测试环境。新增变量已接入环境渲染脚本，凭据不会被提交到源码或传给 Codex 子进程。

## 后台自动检测（主要触发方式）

无需迁移脚本、迁移路径或外部回调。只要 Agent 服务运行且配置了 `DATABASE_URL_READ`，后台就会定时读取结构并与上次发布版本比较。`OA_READ_SYNC_INTERVAL_SECONDS=300` 表示默认每 5 分钟检测；不是实时 DDL 通知，发现变化后还需要完成验证。业务数据行的更新无需同步元数据，查询直接读取数据库当前数据。

同一进程只运行一项同步，重复启动不会增加定时器；暂时连接失败后，下一次检查自动重试。修复失效的表、字段或语义定义后，也会在后续检查中自动恢复，无需重启。查询请求只使用已发布的本地快照，不触发全库结构扫描。

运维如需立即检查，也可使用上述 CLI 或以下可选接口：

- `POST /internal/v1/oa-read/metadata/sync`
- `Authorization: Bearer <OA_AGENT_AUTOMATION_TOKEN>`，请求体 `{}`
- HTTP 200：`status=published|unchanged`；HTTP 409：`status=rejected`，附变化、受影响实体和错误；HTTP 503：同步繁忙或服务不可用，可稍后重试。

该接口仅应在受控部署网络开放，不是用户查询工具，也不是自动同步的前置条件。

## 同步、影响分析与发布

1. 从 `information_schema` 读取表、字段顺序、类型、默认值、空值规则、注释、生成表达式、索引、外键、物理视图定义和视图依赖。索引 cardinality 和行数等易变统计不参与结构版本。
2. 与上次已发布结构比较，标记新增、删除、变更。
3. 检查业务实体列、行权限列、固定筛选和关联引用，传播物理视图和语义实体依赖。
4. 验证所有必要列存在，执行 `SELECT ... LIMIT 0` 验证业务投影及物理视图可查询；再次读取结构，确保同步过程中结构没有再次变化。
5. 哈希结构与业务定义生成版本。通过后原子替换 `current.json`；失败保留上一版，写入 rejected 状态，并暂停数据库业务查询。新增表/字段、索引变化及保持注释与取值规则不变的 varchar 扩容可验证后自动发布结构版本。其他已公开字段的类型、注释、排序规则或生成表达式改变需复核并修改对应语义定义后发布；删除/重命名必要字段需修复引用。

`versions/<hash>.json` 保存不可变发布版本；失败候选单独保存为 `<hash>.rejected.json`。`current.json` 包含活动版本与最近检查报告。恢复方式是修正业务定义或数据库结构，等待下一次后台检查自动重新验证发布；不要仅删除 rejected 标记绕过验证。

同一状态目录使用文件锁避免 CLI、手动刷新和定时任务并发发布；进程内同步合并。锁记录主机与 PID，不自动抢占锁。进程异常退出遗留的锁需由运维确认没有同步任务运行后清理 `.context/oa-read/sync.lock`。

## 业务语义与访问范围

`agent/metadata/oa-read.json` 维护业务别名、字段解释、枚举、固定业务筛选及关联。后台根据实际结构补齐未定义的表和字段，已有业务解释优先于数据库注释；不会猜测枚举或历史口径。只有通过验证并发布的目录可用于结构化查询。

表权限由 `accessPolicy.ts` 按物理表名统一执行，优先级如下：

1. **所有人禁读（包括管理员）**：`enterprise_wechat_mcp_token_state`、`enterprise_wechat_mcp_user_map`、`oa_mcp_grants`、`ws_chat_messages`、`ws_chat_turns`、`ws_task_confirmations`、`ws_task_entries`、`ws_task_events`、`ws_task_members`、`async_task`、`async_task_run`。
2. **仅管理员可读**：`user_weekly_salary`、`ai_reports`、`file_storage`。管理员身份由现有 OA `/admin/permissions` 校验，模型不能自行指定。
3. **其余表**：所有已登录成员可跨成员查询。成员、周报、月报不再注入当前用户 ID 过滤。未列入禁读名单的会话记录和副本表同样按此规则开放。

`async_task`、`async_task_run` 同时出现在用户提出的管理员表和全员禁读表中，按全员禁读处理。元数据 `access` 是发布时计算的权限说明，不能覆盖服务端表策略；旧版 `self`/`ownerColumn` 不再产生本人过滤。新表、新字段同步时自动按以上规则进入查询目录，密码、Token 等凭据字段仍禁止公开，且不接受任意 SQL。

视图递归继承依赖表的最严格权限，防止通过视图别名绕过禁读表。依赖不明、跨库依赖或循环依赖的视图不开放。目录、字段描述、主表查询和 JOIN 都执行同一权限策略。

重要口径：

- `employee_type` 当前值：`full_time` 全职、`part_time` 兼职、`intern` 实习。非实习使用明确枚举集合，不能把 NULL/未知值当成非实习。
- 成员类型与项目参与关系是当前状态，不能还原某月历史身份/成员关系。
- 月份使用 `[月初,下月初)`、Asia/Shanghai；项目最新更新时间不是月内进展。
- 项目摘要可能来自 Commit 或周报归档，周结束日不一定代表单日进展；结合 `ai_note` 说明覆盖范围。
- 周报按 `weekly_report_days` 的日期区间和内部 `weekly_num` 关联，不按周报更新时间推断期间。

## 模型工具和执行约束

模型使用 `node scripts/queryOaDatabase.mjs --input '<JSON>'`：

1. `catalog` 读取允许访问的实体目录（可用 search 筛选）。
2. `describe` 批量读取本题相关实体、字段、枚举和关系。
3. `query` 携带已发布 `version` 和结构化查询计划。

服务端将计划编译为白名单 SQL，支持关联、AND/OR 条件、范围筛选、分组、count/countDistinct/sum/avg/min/max、排序和分页。不接受自由 SQL、任意函数、任意表名或原始表达式。复杂的未支持表达式需扩展编译器及测试，不能让模型绕过工具直连。

每个数据源先验证表权限并施加字段限制及固定业务筛选，再参与 JOIN，值使用 MySQL prepared statements。查询在 `START TRANSACTION READ ONLY` 中执行，并设置数据库执行时间上限；客户端超时销毁连接。连接凭据仅在服务端。模型工具使用按 session 签发的能力令牌，需活跃会话与重新验证的 OA 身份，不能指定 userId/isAdmin。

返回最多配置行数、128 KiB，每个文本字段默认最多 6000 字符。`select` 可用 `textOffset`（从 0 开始）和 `textLength`（最多 6000）分块读取长文本。行分页使用稳定排序、`hasMore` 和 `nextOffset`，offset 最大 10000；更大范围使用 ID 条件继续查询。聚合应在数据库执行，避免将大量明细喂给模型。文本分块和行分页的完整性必须分别判断。

业务查询只读取本地原子版本文件，不扫描 `information_schema`。审计输出查询实体、元数据版本、服务端用户 ID、耗时和行数，不记录连接串、SQL 参数或业务正文。
