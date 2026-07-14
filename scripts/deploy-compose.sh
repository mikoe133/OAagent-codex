#!/usr/bin/env bash

set -Eeuo pipefail

function fail() {
  echo "[deploy] $*" >&2
  exit 1
}

function validate_image() {
  local service="$1"
  local image="$2"
  if [[ ! "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_.-]+$ ]]; then
    fail "invalid $service image reference: $image"
  fi
}

function write_deployment_env() {
  local next_agent_image="$1"
  local next_web_image="$2"
  local temp_file

  umask 077
  temp_file="$(mktemp "${deployment_env_file}.XXXXXX")"
  printf 'AGENT_IMAGE=%s\nWEB_IMAGE=%s\n' \
    "$next_agent_image" \
    "$next_web_image" > "$temp_file"
  mv "$temp_file" "$deployment_env_file"
}

function compose() {
  docker compose \
    --env-file "$runtime_env_file" \
    --env-file "$deployment_env_file" \
    -f "$compose_file" \
    "$@"
}

function rollback() {
  if [[ "$had_previous" -ne 1 ]]; then
    rm -f "$deployment_env_file"
    echo "[deploy] no previous release is available" >&2
    return
  fi

  cp "$previous_env_file" "$deployment_env_file"
  echo "[deploy] rolling back with $previous_env_file" >&2
  compose pull agent web || echo "[deploy] rollback image pull failed" >&2
  compose up -d --no-build --remove-orphans --wait --wait-timeout 180 \
    || echo "[deploy] rollback failed; manual intervention is required" >&2
}

readonly deploy_dir="${1:?usage: deploy-compose.sh DEPLOY_DIR AGENT_IMAGE WEB_IMAGE}"
readonly agent_image="${2:?agent image is required}"
readonly web_image="${3:?web image is required}"

validate_image "agent" "$agent_image"
validate_image "web" "$web_image"

cd "$deploy_dir"

readonly compose_file="compose.yml"
readonly runtime_env_file=".env"
readonly deployment_env_file=".deploy.env"
readonly previous_env_file=".deploy.env.previous"

[[ -f "$compose_file" ]] || fail "missing $deploy_dir/$compose_file"
[[ -f "$runtime_env_file" ]] || fail "missing $deploy_dir/$runtime_env_file"
command -v docker >/dev/null || fail "docker is not installed"
docker compose version >/dev/null

had_previous=0
if [[ -f "$deployment_env_file" ]]; then
  cp "$deployment_env_file" "$previous_env_file"
  had_previous=1
else
  rm -f "$previous_env_file"
fi

write_deployment_env "$agent_image" "$web_image"

if ! compose pull agent web; then
  echo "[deploy] image pull failed; restoring the previous release" >&2
  rollback
  exit 1
fi

if ! compose up -d --no-build --remove-orphans --wait --wait-timeout 180; then
  echo "[deploy] health check failed; restoring the previous release" >&2
  rollback
  exit 1
fi

echo "[deploy] release is healthy"
compose ps
