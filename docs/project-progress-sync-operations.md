# GitHub 项目进度 Worker

默认模式是只读 dry-run：读取 OA 项目和 GitHub 提交、调用隔离的 Responses 模型生成项目级每日总结建议，并把技术水位和草稿保存在 SQLite。

## 运行

Node.js 必须为 22.17.0 或更高版本。按 `.env.example` 配置以下专用变量：

- `OA_API_BASE_URL`
- `OA_PROJECT_SYNC_TOKEN` 及其独立 header/prefix
- `GITHUB_PROJECT_SYNC_TOKEN`
- `NEXTTOKEN_API_KEY`，或 `PROJECT_PROGRESS_MODEL_API_KEY`

执行全部项目：

```bash
npm run sync:project-progress
```

只验证一个项目：

```bash
npm run sync:project-progress -- --project-id 63
```

固定观察时间便于回放：

```bash
npm run sync:project-progress -- --observed-at 2026-07-24T12:00:00.000Z
```

输出中的 `targetStatus` 和 `summaries` 都是建议值，`mutationsApplied` 固定为 `0`。SQLite 默认写入 `.context/project-progress.sqlite`。

## 测试库单项目写入

仅当 OA 通过 `localhost`、`127.0.0.1` 或 `::1` 提供服务并明确连接测试数据库时，才可设置：

```dotenv
PROJECT_PROGRESS_WRITE_ENABLED=true
PROJECT_PROGRESS_UNSAFE_TEST_WRITES=I_UNDERSTAND_TEST_ONLY
```

写入命令必须指定单个测试项目：

```bash
npm run sync:project-progress:test-write -- --project-id 63
```

该模式会在写入前重新读取项目；如果项目已归档或 `github_urls` 已变化，立即取消。未知来源的既有总结不会被覆盖。当前 OA 尚无 version CAS 和创建幂等键，因此禁止对生产库或全项目运行此模式。

## 安全边界

- `archived` 项目在读取详情、解析 URL 和调用 GitHub 之前短路。
- 任一仓库失败时不生成部分总结，也不把项目降级为 `maintenance`。
- 测试写入同时要求 loopback OA 地址、显式确认变量、`--apply-test` 和单个 `--project-id`。
- OA 后端提供项目/总结 version CAS、summary 创建幂等键和最小权限服务身份后，才能开发并启用写入阶段。

工作日 20:00 的 systemd timer 暂不安装。先完成至少 5 个工作日的人工 dry-run 验证，再把同一命令接入定时器。
