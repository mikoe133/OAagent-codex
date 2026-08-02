# OA 自动化与 OAagent 对接

最终联调契约以 [OAagent 集成 API](oaagent_integration_api.md) 为准。本文只记录 OAagent 侧的运行边界，不重复维护接口字段。

## 职责边界

- OA 保存任务定义、标签、Cron、时区、模型快照、运行状态和审计记录。
- OAagent 提供 `/internal/v1/models*`，并执行 `github_project_progress_sync` Worker。
- OAagent 每分钟向 OA claim 一次；工作日 20:00 是否产生运行由 OA 调度器决定。
- OAagent 保存模型供应商密钥；OA 不接收模型 API Key。

## 认证

```dotenv
OA_AGENT_AUTOMATION_TOKEN=<两端一致的自动化服务 token>
OA_PROJECT_SYNC_TOKEN=<两端一致的项目同步服务 token>
```

`OA_AGENT_AUTOMATION_TOKEN` 用于模型目录、claim、heartbeat、运行状态和审计接口。`OA_PROJECT_SYNC_TOKEN` 只用于项目、状态和 commit 总结接口。两者都使用 `Authorization: Bearer`，不得复用用户 session。

## OAagent 运行参数

```dotenv
PROJECT_PROGRESS_WORKER_INSTANCE=oaagent-test-01
PROJECT_PROGRESS_LEASE_SECONDS=300
PROJECT_PROGRESS_HEARTBEAT_SECONDS=60
```

`worker_instance` 在同一 Worker 生命周期内保持稳定。心跳间隔必须小于租约，并在项目结果与 AI 审计上报完成前持续运行。

## 网络

本地联调建议 OA 使用 `http://127.0.0.1:3002`，OAagent 使用 `http://127.0.0.1:3001`。服务器部署仍使用 CI/CD 固定的测试与生产端口；自动化接口只绑定 loopback 或受控内网，不直接暴露公网。
