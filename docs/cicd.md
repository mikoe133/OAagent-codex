# GitHub Actions CI/CD

`.github/workflows/ci-cd.yml` 提供三层流水线:

1. 所有 Pull Request:运行 agent/web/部署回滚测试、类型检查、应用构建和 Compose 校验。
2. Pull Request 与 `main`:分别构建 `agent-runtime`、`web-runtime` Docker target。
3. `main` 推送或从 `main` 手动触发:把 commit SHA 镜像推送到 GHCR,再通过 SSH 部署到 production。

生产镜像使用不可变 SHA 标签:

```text
ghcr.io/mikoe133/oaagent-codex-agent:<commit-sha>
ghcr.io/mikoe133/oaagent-codex-web:<commit-sha>
```

`main` 标签仅用于查看最新镜像,生产 Compose 实际使用 SHA 标签。

## GitHub production Environment

在仓库 `Settings -> Environments` 创建 `production`,并配置以下 Environment secrets:

| Secret | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 部署服务器域名或 IP |
| `DEPLOY_USER` | 有权运行 Docker 的 SSH 用户 |
| `DEPLOY_SSH_KEY` | 对应服务器 authorized_keys 的私钥 |
| `DEPLOY_KNOWN_HOSTS` | 服务器 SSH host key 完整记录 |
| `GHCR_PULL_TOKEN` | GitHub PAT,至少包含 `read:packages` |

建议为 `production` 增加 required reviewers,防止合并后未经审批直接发布。

可选 Environment variables:

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `DEPLOY_PATH` | `/opt/oa-agent` | 服务器部署目录,不要包含空格 |
| `DEPLOY_PORT` | `22` | SSH 端口 |

可选 Repository variable:

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `DEPLOY_PLATFORM` | `linux/amd64` | Docker 目标平台;ARM 服务器改为 `linux/arm64` |

生成 `DEPLOY_KNOWN_HOSTS` 时应在可信网络核对服务器指纹:

```bash
ssh-keyscan -p 22 your-server.example.com
```

不要关闭 workflow 中的 host key 校验,也不要把私钥、PAT 或 `.env` 提交到仓库。

## 服务器首次准备

服务器需要 Docker Engine、Docker Compose v2.20+ 和可访问的现有 OA 服务。部署用户必须能够直接运行 `docker`。

在 `DEPLOY_PATH` 下准备 `.env`,至少包含:

```dotenv
OPENROUTER_API_KEY=<secret>
AGENT_API_TOKEN=<random-secret>
OA_DOCKER_API_BASE_URL=http://host.docker.internal:8010
WEB_BIND_ADDRESS=0.0.0.0
WEB_PORT=3000
OA_AUTH_ALIAS=default
```

Workflow 每次只上传 `compose.yml`;不会覆盖服务器 `.env`、`agent_sessions` 或 `agent_codex_home`。

## 发布与回滚

合并到 `main` 后自动执行生产发布。也可以在 Actions 页面从 `main` 手动运行 `CI/CD`。

部署脚本会先保存 `.deploy.env.previous`,然后拉取并健康检查新镜像。如果拉取或健康检查失败,会自动恢复上一版镜像。手动回滚命令:

```bash
cd /opt/oa-agent
cp .deploy.env.previous .deploy.env
docker compose --env-file .env --env-file .deploy.env pull agent web
docker compose --env-file .env --env-file .deploy.env up -d --no-build --remove-orphans --wait --wait-timeout 180
```

首次部署没有上一版本可回滚;发布前应先确认 OA 服务、HTTPS 反向代理和 `.env` 配置可用。
