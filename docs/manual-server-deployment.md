# OA Agent 手动受限构建部署

本文用于 GitHub Actions 暂时不可用或 Artifact 配额耗尽时的手动发布。

部署方式:

```text
本地检查并打包源码
  -> SCP 上传源码压缩包
  -> 服务器受限 BuildKit 顺序构建 agent/web
  -> 健康检查通过后切换容器
  -> 失败时自动恢复上一版镜像
```

本地不需要安装 Docker。服务器构建器最多使用约 1 个 CPU、2.5 GiB 内存,并且每次只执行一个构建步骤。测试和生产必须分别发布,不要同时构建。

## 固定路径

| 项目 | 测试环境 | 生产环境 |
| --- | --- | --- |
| 服务器运行目录 | `/opt/rwkv/apps/oa-agent-test` | `/opt/rwkv/apps/oa-agent-prod` |
| Compose 项目名 | `oa-agent-test` | `oa-agent-prod` |
| Agent 监听地址 | `192.168.251.1:3003` | `127.0.0.1:3011`（默认） |
| Web 监听地址 | `127.0.0.1:3001` | `127.0.0.1:3010` |
| 公网地址 | `https://test.oa-agent.rwkvos.com` | `https://oa-agent.rwkvos.com` |

本地仓库路径:

```text
/Volumes/outssd/mac-home/conductor/workspaces/oaagent-codex/damascus
```

## 一次性准备

以下步骤只需要在新服务器上执行一次。当前服务器已经完成时可直接跳到“每次发布”。

### 1. 检查服务器

```bash
docker --version
docker compose version
docker buildx version
nproc
free -h
df -h
```

服务器少于 2 个 CPU 时不要在业务服务器构建。

### 2. 检查运行时环境文件

测试环境:

```bash
nano /opt/rwkv/apps/oa-agent-test/.env
chmod 600 /opt/rwkv/apps/oa-agent-test/.env
```

生产环境:

```bash
nano /opt/rwkv/apps/oa-agent-prod/.env
chmod 600 /opt/rwkv/apps/oa-agent-prod/.env
```

每个环境的 `.env` 至少需要包含:

```dotenv
COMPOSE_PROJECT_NAME=oa-agent-test
NEXTTOKEN_API_KEY=<secret>
OPENROUTER_API_KEY=<secret>
OA_DOCKER_API_BASE_URL=http://host.docker.internal:8010
OA_KNOWLEDGE_API_BASE_URL=https://oa-kb.rwkvos.com/api/agent/v1
OA_KNOWLEDGE_BASE_API_KEY=<secret>
AUTOMATION_API_BASE_URL=http://agent:3000
PROJECT_SYNC_API_BASE_URL=http://old-oa-server
DATABASE_URL=<由安全渠道写入的对应环境 MySQL Secret>
OA_SESSION_SECRET=<与对应原 OA 一致>
OA_AGENT_SSO_SHARED_SECRET=<与对应 OA 服务端一致的密钥>
OA_AGENT_SSO_TTL_SECONDS=300
OA_AGENT_AUTOMATION_TOKEN=<与对应 OA 服务端一致的自动化专用密钥>
OA_PROJECT_SYNC_TOKEN=<OA 项目进度同步专用密钥>
PROJECT_PROGRESS_GITHUB_TOKEN=<可读取目标仓库与 GitHub Project 的 Token>
PROJECT_PROGRESS_GITHUB_CONCURRENCY=6
PROJECT_PROGRESS_AGENT_CONCURRENCY=2
PROJECT_PROGRESS_OA_WRITE_CONCURRENCY=1
PROJECT_PROGRESS_WORKSPACE_ROOT=/app/.context/project-progress-workspaces
AGENT_BIND_ADDRESS=192.168.251.1
AGENT_PORT=3003
WEB_BIND_ADDRESS=127.0.0.1
WEB_PORT=3001
```

Compose 内的 `AUTOMATION_API_BASE_URL` 已固定为同一项目的 `http://agent:3000`；`PROJECT_SYNC_API_BASE_URL` 继续填写原 OA 地址。完整 `DATABASE_URL` 不得上传到 Git 或源码压缩包。

`192.168.251.1` 是当前服务器的 `docker0` 地址,用于让同机但位于其他 Docker 网络的 OA 后端访问测试 Agent。换服务器后用 `ip -4 addr show docker0` 重新确认。测试服务器的 `3002` 端口由 Alphachain/OA Node 服务使用，因此测试 Agent 固定使用 `3003`。生产环境将 `COMPOSE_PROJECT_NAME` 改为 `oa-agent-prod`，将 `AGENT_BIND_ADDRESS` 改为 `127.0.0.1`（生产 OA 后端需要跨容器访问时改为其可达的宿主机地址），将 `AGENT_PORT` 改为 `3011`，将 `WEB_PORT` 改为 `3010`，并使用生产环境自己的 SSO 与自动化密钥。不要把 `.env` 上传到 Git 或源码压缩包。

### 3. 创建受限 BuildKit

服务器执行:

```bash
sudo install -d -m 0750 \
  -o "$USER" \
  -g "$(id -gn)" \
  /opt/rwkv/build/releases

cat > "$HOME/oa-safe-buildkitd-cn2.toml" <<'EOF'
[worker.oci]
  max-parallelism = 1

[registry."docker.io"]
  mirrors = ["dqtao5i5.mirror.aliyuncs.com"]
EOF

if ! docker buildx inspect oa-safe-builder-cn2 >/dev/null 2>&1; then
  docker buildx create \
    --name oa-safe-builder-cn2 \
    --driver docker-container \
    --buildkitd-config "$HOME/oa-safe-buildkitd-cn2.toml" \
    --driver-opt cpu-period=100000 \
    --driver-opt cpu-quota=100000 \
    --driver-opt cpu-shares=128 \
    --driver-opt memory=2500m \
    --driver-opt memory-swap=5g
fi

docker buildx inspect oa-safe-builder-cn2 --bootstrap
docker buildx stop oa-safe-builder-cn2
```

`cpu-quota=100000` 与 `cpu-period=100000` 将构建器限制在约 1 个 CPU。`max-parallelism=1` 防止 BuildKit 并行执行多个 Dockerfile 步骤。运行中的 agent/web 容器不受 Builder 启停影响。

## 每次发布

始终先发布测试环境。测试验证完成后,重新用 `main` 分支源码发布生产环境。

### 第 1 步:本地检查代码

在本地 Mac 执行:

```bash
cd "/Volumes/outssd/mac-home/conductor/workspaces/oaagent-codex/damascus"

git status --short
npm run test:deploy
npm run typecheck
npm test --workspace=agent
npm run test:chat --workspace=frontend
```

确认测试通过。`git status` 中如有项目需要的未跟踪文件(`??`),也会被下面的源码打包命令包含;打包前必须确认其中没有密钥、日志或个人文件。

### 第 2 步:本地打包并上传

把 `<服务器IP或域名>` 替换成真实地址,然后整段执行:

```bash
set -Eeuo pipefail

cd "/Volumes/outssd/mac-home/conductor/workspaces/oaagent-codex/damascus"

test -f Dockerfile
test -f compose.yml
test -f scripts/deploy-compose.sh

ARCHIVE=/tmp/oa-agent-source.tar.gz

COPYFILE_DISABLE=1 tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./frontend/.next' \
  --exclude='./agent/dist' \
  --exclude='./.context' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*/coverage' \
  -czf "$ARCHIVE" \
  .

tar -tzf "$ARCHIVE" | grep -Eq '^\./Dockerfile$|^Dockerfile$'

scp "$ARCHIVE" \
  rwkvuser@47.115.88.183:/tmp/oa-agent-source.tar.gz
```

压缩包在本地 Mac 的 `/tmp/oa-agent-source.tar.gz`,不在项目目录内。上传会覆盖服务器 `/tmp` 中的上一份源码包,不会影响正在运行的容器。

### 第 3 步:服务器构建并发布测试环境

登录服务器:

```bash
ssh rwkvuser@<服务器IP或域名>
```

下面整段命令只需要确认第一项 `TARGET=test`,其余不需要修改:

```bash
set -Eeuo pipefail

TARGET=test
ARCHIVE=/tmp/oa-agent-source.tar.gz
BUILDER=oa-safe-builder-cn2
NODE_IMAGE=docker.m.daocloud.io/library/node:22.17.0-bookworm-slim
TAG="$(date +%Y%m%d-%H%M%S)"
SOURCE_DIR="/opt/rwkv/build/releases/$TAG"

case "$TARGET" in
  test)
    DEPLOY_DIR=/opt/rwkv/apps/oa-agent-test
    IMAGE_PREFIX=oa-agent-test
    PROJECT_NAME=oa-agent-test
    AGENT_PORT=3003
    WEB_PORT=3001
    ;;
  production)
    DEPLOY_DIR=/opt/rwkv/apps/oa-agent-prod
    IMAGE_PREFIX=oa-agent-prod
    PROJECT_NAME=oa-agent-prod
    AGENT_PORT=3011
    WEB_PORT=3010
    ;;
  *)
    echo "TARGET must be test or production" >&2
    exit 1
    ;;
esac

AGENT_IMAGE="$IMAGE_PREFIX-agent:manual-$TAG"
WEB_IMAGE="$IMAGE_PREFIX-web:manual-$TAG"
SERVER_DOCKERFILE="$SOURCE_DIR/Dockerfile.server"

test -s "$ARCHIVE"
test -s "$DEPLOY_DIR/.env"

for name in \
  COMPOSE_PROJECT_NAME \
  NEXTTOKEN_API_KEY \
  OPENROUTER_API_KEY \
  OA_DOCKER_API_BASE_URL \
  OA_AGENT_SSO_SHARED_SECRET \
  OA_AGENT_SSO_TTL_SECONDS \
  OA_AGENT_AUTOMATION_TOKEN \
  OA_PROJECT_SYNC_TOKEN \
  PROJECT_PROGRESS_GITHUB_TOKEN \
  AGENT_BIND_ADDRESS \
  AGENT_PORT \
  WEB_PORT; do
  grep -q "^${name}=." "$DEPLOY_DIR/.env" || {
    echo "Missing $name in $DEPLOY_DIR/.env" >&2
    exit 1
  }
done

grep -qx "COMPOSE_PROJECT_NAME=$PROJECT_NAME" "$DEPLOY_DIR/.env" || {
  echo "COMPOSE_PROJECT_NAME must be $PROJECT_NAME" >&2
  exit 1
}

grep -qx "WEB_PORT=$WEB_PORT" "$DEPLOY_DIR/.env" || {
  echo "WEB_PORT must be $WEB_PORT" >&2
  exit 1
}

grep -qx "AGENT_PORT=$AGENT_PORT" "$DEPLOY_DIR/.env" || {
  echo "AGENT_PORT must be $AGENT_PORT" >&2
  exit 1
}

install -d -m 0750 "$SOURCE_DIR"
tar -xzf "$ARCHIVE" -C "$SOURCE_DIR"

test -f "$SOURCE_DIR/Dockerfile"
test -f "$SOURCE_DIR/compose.yml"
test -f "$SOURCE_DIR/scripts/deploy-compose.sh"

sed '1{/^# syntax=docker\/dockerfile:/d;}' \
  "$SOURCE_DIR/Dockerfile" \
  > "$SERVER_DOCKERFILE"

docker buildx inspect "$BUILDER" --bootstrap
trap 'docker buildx stop "$BUILDER" >/dev/null 2>&1 || true' EXIT

docker buildx build \
  --builder "$BUILDER" \
  --file "$SERVER_DOCKERFILE" \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --pull \
  --load \
  --target agent-runtime \
  -t "$AGENT_IMAGE" \
  "$SOURCE_DIR"

docker buildx build \
  --builder "$BUILDER" \
  --file "$SERVER_DOCKERFILE" \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --pull \
  --load \
  --target web-runtime \
  -t "$WEB_IMAGE" \
  "$SOURCE_DIR"

docker image inspect "$AGENT_IMAGE" >/dev/null
docker image inspect "$WEB_IMAGE" >/dev/null
docker buildx stop "$BUILDER"
trap - EXIT

cp "$DEPLOY_DIR/compose.yml" \
  "$DEPLOY_DIR/compose.yml.before-$TAG"

install -m 0644 \
  "$SOURCE_DIR/compose.yml" \
  "$DEPLOY_DIR/compose.yml"

SKIP_IMAGE_PULL=1 \
  bash "$SOURCE_DIR/scripts/deploy-compose.sh" \
  "$DEPLOY_DIR" \
  "$AGENT_IMAGE" \
  "$WEB_IMAGE"

docker compose \
  --env-file "$DEPLOY_DIR/.env" \
  --env-file "$DEPLOY_DIR/.deploy.env" \
  -f "$DEPLOY_DIR/compose.yml" \
  ps

curl -fsS "http://127.0.0.1:$WEB_PORT/login" >/dev/null

echo "Deployment succeeded: $TARGET $TAG"
echo "Agent image: $AGENT_IMAGE"
echo "Web image: $WEB_IMAGE"
```

构建阶段不会修改运行中的服务。只有两个镜像都成功构建后才会安装新 `compose.yml` 并执行部署。部署脚本使用 Compose 健康检查;失败时会恢复 `.deploy.env.previous` 指向的上一版镜像。

### 第 4 步:浏览器验证测试环境

检查:

1. 打开 `https://test.oa-agent.rwkvos.com`。
2. 完成 OA 登录或 SSO。
3. 打开 `/chat`。
4. 发送一条消息并确认 Agent 可以读取 OA 数据。
5. 检查服务器负载已恢复正常。

```bash
free -h
uptime
docker stats --no-stream
```

### 第 5 步:发布生产环境

先确保本地是准备发布的 `main` 代码,重新执行“本地打包并上传”。然后在服务器重复第 3 步,只把这一行改为:

```bash
TARGET=production
```

发布完成后验证:

```text
https://oa-agent.rwkvos.com
```

不要复用测试环境的 `.env`、SSO 密钥、Compose 项目名或端口。

## 构建和发布失败

### 构建失败

构建失败时脚本会在 `trap` 中停止 Builder。此时新镜像不会部署,线上容器保持不变。修复问题后重新上传源码并执行新的发布块,让时间戳生成新的版本。

检查 Builder 是否已停止:

```bash
docker buildx inspect oa-safe-builder-cn2
```

### 部署健康检查失败

`scripts/deploy-compose.sh` 会自动恢复上一份 `.deploy.env` 并重新启动上一版镜像。检查:

```bash
cd /opt/rwkv/apps/oa-agent-test
docker compose --env-file .env --env-file .deploy.env -f compose.yml ps
docker compose --env-file .env --env-file .deploy.env -f compose.yml logs --tail=200 agent web
```

生产环境将目录替换为 `/opt/rwkv/apps/oa-agent-prod`。

## 手动回滚

进入对应部署目录后执行:

```bash
cd /opt/rwkv/apps/oa-agent-test

test -f .deploy.env.previous
cp .deploy.env .deploy.env.failed
cp .deploy.env.previous .deploy.env
chmod 600 .deploy.env

docker compose \
  --env-file .env \
  --env-file .deploy.env \
  -f compose.yml \
  up -d --no-build --remove-orphans --wait --wait-timeout 180
```

如果需要同时恢复发布前的 Compose 文件,先查看备份并选择对应版本:

```bash
ls -1t compose.yml.before-*
```

确认后再复制指定文件,不要盲目选择旧版本。不要执行 `docker compose down -v`,否则会删除 session 和 Codex thread 数据卷。

## 日常清理

每次发布都会保留带时间戳的源码目录和镜像,用于回滚。不要在发布脚本中自动清理。磁盘空间不足时先查看:

```bash
df -h
du -sh /opt/rwkv/build/releases/*
docker image ls 'oa-agent-*'
```

至少保留当前版本和上一版本。确认不再需要更早版本后再人工删除对应源码目录和镜像。

## 最短操作清单

以后每次发布只需要:

1. 本地运行测试。
2. 本地执行“打包并上传”代码块。
3. 服务器执行发布代码块,测试环境使用 `TARGET=test`。
4. 浏览器验证测试环境。
5. 重新打包 `main` 代码,服务器使用 `TARGET=production` 发布生产环境。
