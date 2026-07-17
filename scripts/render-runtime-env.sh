#!/usr/bin/env bash

set -Eeuo pipefail

function fail() {
  echo "[runtime-env] $*" >&2
  exit 1
}

function require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "missing $name"
}

function reject_multiline() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || fail "$name must be a single line"
}

readonly output_path="${1:?usage: render-runtime-env.sh OUTPUT_PATH}"

for name in COMPOSE_PROJECT_NAME NEXTTOKEN_API_KEY OPENROUTER_API_KEY OA_DOCKER_API_BASE_URL WEB_PORT; do
  require_value "$name"
done

readonly oa_auth_alias="${OA_AUTH_ALIAS:-default}"
readonly web_bind_address="${WEB_BIND_ADDRESS:-127.0.0.1}"
readonly nexttoken_api_base_url="${NEXTTOKEN_API_BASE_URL:-https://next-token.cc}"
readonly openrouter_api_base_url="${OPENROUTER_API_BASE_URL:-https://openrouter.ai/api/v1}"

for name in \
  COMPOSE_PROJECT_NAME \
  NEXTTOKEN_API_KEY \
  OPENROUTER_API_KEY \
  OA_DOCKER_API_BASE_URL \
  OA_AUTH_ALIAS \
  WEB_BIND_ADDRESS \
  NEXTTOKEN_API_BASE_URL \
  OPENROUTER_API_BASE_URL \
  WEB_PORT; do
  reject_multiline "$name"
done

[[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || fail "COMPOSE_PROJECT_NAME contains unsupported characters"
[[ "$OA_DOCKER_API_BASE_URL" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "OA_DOCKER_API_BASE_URL must be an HTTP(S) URL"
[[ "$nexttoken_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "NEXTTOKEN_API_BASE_URL must be an HTTP(S) URL"
[[ "$openrouter_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "OPENROUTER_API_BASE_URL must be an HTTP(S) URL"
[[ "$oa_auth_alias" =~ ^[A-Za-z0-9_-]+$ ]] \
  || fail "OA_AUTH_ALIAS contains unsupported characters"
[[ "$web_bind_address" =~ ^[A-Za-z0-9:._-]+$ ]] \
  || fail "WEB_BIND_ADDRESS contains unsupported characters"
[[ "$WEB_PORT" =~ ^[0-9]+$ ]] \
  || fail "WEB_PORT must be a number"
(( WEB_PORT >= 1 && WEB_PORT <= 65535 )) \
  || fail "WEB_PORT must be between 1 and 65535"

umask 077
readonly temp_path="$(mktemp "${output_path}.XXXXXX")"
trap 'rm -f "$temp_path"' EXIT

{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'NEXTTOKEN_API_KEY=%s\n' "$NEXTTOKEN_API_KEY"
  printf 'NEXTTOKEN_API_BASE_URL=%s\n' "$nexttoken_api_base_url"
  printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
  printf 'OPENROUTER_API_BASE_URL=%s\n' "$openrouter_api_base_url"
  printf 'CODEX_MODEL_PROVIDER=nexttoken\n'
  printf 'CODEX_MODEL=gpt-5.6-terra\n'
  printf 'OA_DOCKER_API_BASE_URL=%s\n' "$OA_DOCKER_API_BASE_URL"
  printf 'OA_API_TOKEN_HEADER=Cookie\n'
  printf 'OA_API_TOKEN_PREFIX=sessionid=\n'
  printf 'OA_AUTH_ALIAS=%s\n' "$oa_auth_alias"
  printf 'OA_USER_TOKEN_HEADER=Authorization\n'
  printf 'OA_USER_TOKEN_PREFIX=Bearer\n'
  printf 'WEB_BIND_ADDRESS=%s\n' "$web_bind_address"
  printf 'WEB_PORT=%s\n' "$WEB_PORT"
} > "$temp_path"

chmod 600 "$temp_path"
mv -f "$temp_path" "$output_path"
trap - EXIT
