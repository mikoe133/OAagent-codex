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

function pull_images() {
  if [[ "${SKIP_IMAGE_PULL:-0}" == "1" ]]; then
    echo "[deploy] using preloaded images"
    return 0
  fi

  compose pull agent web
}

function compose_up_once() {
  : > "$compose_up_log_file"
  compose up -d --no-build --remove-orphans --wait --wait-timeout 180 \
    2>&1 | tee "$compose_up_log_file"
}

function start_release() {
  local phase="$1"

  if compose_up_once; then
    return 0
  fi

  if ! grep -Eiq \
    'failed to bind host port|port is already allocated|address already in use' \
    "$compose_up_log_file"; then
    return 1
  fi

  echo "[deploy] $phase port binding failed; resetting this Compose project before one retry" >&2
  if ! compose down --remove-orphans --timeout 30; then
    echo "[deploy] failed to reset this Compose project" >&2
    return 1
  fi

  compose_up_once
}

function rollback() {
  restore_runtime_env

  if [[ "$had_previous" -ne 1 ]]; then
    rm -f "$deployment_env_file"
    echo "[deploy] no previous release is available" >&2
    return
  fi

  cp "$previous_env_file" "$deployment_env_file"
  chmod 600 "$deployment_env_file"
  echo "[deploy] rolling back with $previous_env_file" >&2
  pull_images || echo "[deploy] rollback image pull failed" >&2
  start_release "rollback" \
    || echo "[deploy] rollback failed; manual intervention is required" >&2
}

function promote_runtime_env() {
  if [[ ! -f "$staged_runtime_env_file" ]]; then
    return
  fi

  if [[ -f "$runtime_env_file" ]]; then
    cp "$runtime_env_file" "$previous_runtime_env_file"
    chmod 600 "$previous_runtime_env_file"
    had_previous_runtime=1
  else
    rm -f "$previous_runtime_env_file"
  fi

  chmod 600 "$staged_runtime_env_file"
  mv "$staged_runtime_env_file" "$runtime_env_file"
  runtime_env_changed=1
}

function restore_runtime_env() {
  if [[ "$runtime_env_changed" -ne 1 ]]; then
    return
  fi

  if [[ "$had_previous_runtime" -eq 1 ]]; then
    cp "$previous_runtime_env_file" "$runtime_env_file"
    chmod 600 "$runtime_env_file"
  else
    rm -f "$runtime_env_file"
  fi
}

readonly deploy_dir="${1:?usage: deploy-compose.sh DEPLOY_DIR AGENT_IMAGE WEB_IMAGE}"
readonly agent_image="${2:?agent image is required}"
readonly web_image="${3:?web image is required}"

validate_image "agent" "$agent_image"
validate_image "web" "$web_image"

cd "$deploy_dir"

readonly compose_file="compose.yml"
readonly runtime_env_file=".env"
readonly staged_runtime_env_file=".env.next"
readonly previous_runtime_env_file=".env.previous"
readonly deployment_env_file=".deploy.env"
readonly previous_env_file=".deploy.env.previous"
readonly compose_up_log_file="$(mktemp "${TMPDIR:-/tmp}/oa-agent-compose-up.XXXXXX")"

trap 'rm -f "$compose_up_log_file"' EXIT

[[ -f "$compose_file" ]] || fail "missing $deploy_dir/$compose_file"
command -v docker >/dev/null || fail "docker is not installed"
docker compose version >/dev/null

had_previous_runtime=0
runtime_env_changed=0
promote_runtime_env
[[ -f "$runtime_env_file" ]] || fail "missing $deploy_dir/$runtime_env_file"

had_previous=0
if [[ -f "$deployment_env_file" ]]; then
  cp "$deployment_env_file" "$previous_env_file"
  chmod 600 "$previous_env_file"
  had_previous=1
else
  rm -f "$previous_env_file"
fi

write_deployment_env "$agent_image" "$web_image"

if ! pull_images; then
  echo "[deploy] image pull failed; restoring the previous release" >&2
  rollback
  exit 1
fi

if ! start_release "release"; then
  echo "[deploy] health check failed; restoring the previous release" >&2
  rollback
  exit 1
fi

echo "[deploy] release is healthy"
compose ps
