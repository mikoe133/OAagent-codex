# 文档索引

项目文档保留当前接口契约、部署步骤、运行规则和故障排查方法。历史实施计划、测试结果、验收记录和阶段周报不作为维护文档；需要追溯时查看 Git 历史。

## 开发与对话接入

| 文档 | 用途 |
| --- | --- |
| [项目说明](../README.md) | 本地运行、目录结构和常用命令 |
| [后端说明](../agent/README.md) | 后端分层、配置与工具边界 |
| [对外对话 API](agent-public-api.md) | 外部系统接入 OA 会话、消息和请求管理 |
| [服务端 API](server-api.md) | 服务配置、内部能力及对话协议细节 |
| [认证 API](auth_api.md) | OA 登录与认证契约 |
| [Copilot API](copilot_api.md) | OA 会话历史存取契约 |
| [知识库 Agent API](../agent/knowledgebaseapi/AGENT_API.md) | 知识库读取、编辑和权限规则 |
| [OA 只读数据库与元数据](oa-read-database.md) | 数据库查询路由、访问规则、表字段变化自动检测与版本发布 |
| [生产对话路由](public-chat-routing.md) | Nginx 路径、上游和接入验证 |

## 自动任务与周报

| 文档 | 用途 |
| --- | --- |
| [自动任务 API](automation_api.md) | 任务管理、调度、租约和数据存储 |
| [OA 自动化对接](oa-automation-integration.md) | Node 自动化服务与 OA 业务服务的职责边界 |
| [Worker 集成 API](oaagent_integration_api.md) | 模型目录、claim、heartbeat、结果和业务写入契约 |
| [提示词配置 API](automation_prompt_profile_api.md) | 任务类型提示词的配置、版本和运行快照 |
| [运行 Trace API](automation_run_trace_api.md) | 自动任务执行进度与事件查询 |
| [单项目总结 API](oa_targeted_project_summary_api.md) | 定向触发、查询与取消项目总结 |
| [GitHub 项目进度 Worker](project-progress-sync-operations.md) | 运行配置、并发、重试、周报同步和排障 |
| [周报项目总结同步](weekly-report-project-summary-sync-api.md) | 周报更新事件驱动的项目总结写入 |
| [整篇周报重写 API](weekly-report-rewrite-api.md) | 当天项目摘要与当前周报合并、内容哈希校验 |

## 部署与运维

| 文档 | 用途 |
| --- | --- |
| [双环境部署](dual-environment-deployment.md) | 测试与生产环境准备和配置 |
| [CI/CD](cicd.md) | GitHub Actions 构建、部署与回滚 |
| [手动部署](manual-server-deployment.md) | CI 不可用时的受限构建与部署流程 |
| [自动任务数据库与迁移](automation-node-migration.md) | Node 服务路由、MySQL 迁移与维护进程 |
| [对话延迟观测](chat-latency-observability.md) | 对话耗时指标与定位方法 |
| [对话 Trace 存储](chat-trace-storage.md) | 本地 Trace、OA 历史字段与失败补存 |

新增文档优先补充现有主题，并更新此索引。接口示例和可重复执行的验证步骤保留在对应文档中；一次性测试输出和排查过程不提交到文档目录。运行时提示词位于 `agent/prompts/`，接口契约位于 `agent/openapi/` 和 `agent/knowledgebaseapi/`。
