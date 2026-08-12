# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.17.0-bookworm-slim

FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
COPY agent/package.json ./agent/package.json
COPY frontend/package.json ./frontend/package.json

FROM manifests AS agent-build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=agent --include-workspace-root
COPY agent/tsconfig.json ./agent/tsconfig.json
COPY agent/src ./agent/src
RUN npm run build --workspace=agent

FROM manifests AS agent-production-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=agent --include-workspace-root

FROM ${NODE_IMAGE} AS agent-runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=3000 \
    AGENT_SESSION_STORE=/app/.context/agent-sessions.json
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.context /home/node/.codex \
    && chown -R node:node /app /home/node/.codex
COPY --from=agent-production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=agent-build --chown=node:node /app/agent/dist ./agent/dist
COPY --chown=node:node agent/package.json ./agent/package.json
COPY --chown=node:node agent/openapi ./agent/openapi
COPY --chown=node:node agent/prompts ./agent/prompts
COPY --chown=node:node agent/scripts ./agent/scripts
COPY --chown=node:node scripts/sql ./scripts/sql
USER node
EXPOSE 3000
CMD ["node", "agent/dist/runtime/server.js"]

FROM manifests AS web-build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=frontend --include-workspace-root
COPY frontend ./frontend
RUN npm run build --workspace=frontend

FROM ${NODE_IMAGE} AS web-runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN chown node:node /app
COPY --from=web-build --chown=node:node /app/frontend/.next/standalone ./
COPY --from=web-build --chown=node:node /app/frontend/.next/static ./frontend/.next/static
COPY --from=web-build --chown=node:node /app/frontend/public ./frontend/public
USER node
EXPOSE 3000
CMD ["node", "frontend/server.js"]
