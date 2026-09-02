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

for name in COMPOSE_PROJECT_NAME NEXTTOKEN_API_KEY OPENROUTER_API_KEY OA_DOCKER_API_BASE_URL OA_KNOWLEDGE_BASE_API_KEY OA_AGENT_SSO_SHARED_SECRET OA_AGENT_SSO_TTL_SECONDS OA_AGENT_AUTOMATION_TOKEN OA_PROJECT_SYNC_TOKEN PROJECT_PROGRESS_GITHUB_APP_ID DATABASE_URL OA_SESSION_SECRET AGENT_PORT WEB_PORT; do
  require_value "$name"
done

readonly oa_auth_alias="${OA_AUTH_ALIAS:-default}"
readonly agent_bind_address="${AGENT_BIND_ADDRESS:-127.0.0.1}"
readonly web_bind_address="${WEB_BIND_ADDRESS:-127.0.0.1}"
readonly nexttoken_api_base_url="${NEXTTOKEN_API_BASE_URL:-https://next-token.cc}"
readonly openrouter_api_base_url="${OPENROUTER_API_BASE_URL:-https://openrouter.ai/api/v1}"
readonly automation_api_base_url="${AUTOMATION_API_BASE_URL:-$OA_DOCKER_API_BASE_URL}"
readonly project_sync_api_base_url="${PROJECT_SYNC_API_BASE_URL:-$OA_DOCKER_API_BASE_URL}"
readonly oa_knowledge_api_base_url="${OA_KNOWLEDGE_API_BASE_URL:-https://oa-kb.rwkvos.com/api/agent/v1}"
readonly oa_project_sync_token_header="${OA_PROJECT_SYNC_TOKEN_HEADER:-Authorization}"
readonly oa_project_sync_token_prefix="${OA_PROJECT_SYNC_TOKEN_PREFIX:-Bearer}"
readonly project_progress_worker_instance="${PROJECT_PROGRESS_WORKER_INSTANCE:-oaagent-${COMPOSE_PROJECT_NAME}}"
readonly project_progress_lease_seconds="${PROJECT_PROGRESS_LEASE_SECONDS:-300}"
readonly project_progress_heartbeat_seconds="${PROJECT_PROGRESS_HEARTBEAT_SECONDS:-10}"
readonly project_progress_github_app_id="${PROJECT_PROGRESS_GITHUB_APP_ID}"
readonly project_progress_github_concurrency="${PROJECT_PROGRESS_GITHUB_CONCURRENCY:-6}"
readonly project_progress_github_max_branches="${PROJECT_PROGRESS_GITHUB_MAX_BRANCHES:-500}"
readonly project_progress_github_max_commit_pages_per_branch="${PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH:-100}"
readonly project_progress_github_max_requests_per_repository="${PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY:-2000}"
readonly project_progress_github_max_requests_per_run="${PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN:-20000}"
readonly project_progress_agent_concurrency="${PROJECT_PROGRESS_AGENT_CONCURRENCY:-2}"
readonly project_progress_oa_write_concurrency="${PROJECT_PROGRESS_OA_WRITE_CONCURRENCY:-4}"
readonly project_progress_agent_max_detail_calls="${PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS:-12}"
readonly project_progress_agent_max_files_per_commit="${PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT:-20}"
readonly project_progress_agent_max_patch_chars_per_file="${PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE:-1200}"
readonly project_progress_agent_max_total_patch_chars="${PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS:-12000}"
readonly automation_expected_database_name="${AUTOMATION_EXPECTED_DATABASE_NAME:-}"
readonly oa_session_verify_max_age="${OA_SESSION_VERIFY_MAX_AGE:-0}"
readonly automation_migrate_on_start="${AUTOMATION_MIGRATE_ON_START:-true}"
readonly automation_maintenance_enabled="${AUTOMATION_MAINTENANCE_ENABLED:-true}"
readonly automation_maintenance_interval_seconds="${AUTOMATION_MAINTENANCE_INTERVAL_SECONDS:-30}"
readonly automation_model_catalog_ttl_seconds="${AUTOMATION_MODEL_CATALOG_TTL_SECONDS:-300}"
readonly automation_model_catalog_stale_seconds="${AUTOMATION_MODEL_CATALOG_STALE_SECONDS:-86400}"
readonly automation_schedule_grace_seconds="${AUTOMATION_SCHEDULE_GRACE_SECONDS:-120}"
readonly automation_manual_trigger_limit="${AUTOMATION_MANUAL_TRIGGER_LIMIT:-3}"
readonly automation_manual_trigger_window_seconds="${AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS:-300}"

for name in \
  COMPOSE_PROJECT_NAME \
  NEXTTOKEN_API_KEY \
  OPENROUTER_API_KEY \
  OA_DOCKER_API_BASE_URL \
  OA_KNOWLEDGE_API_BASE_URL \
  OA_KNOWLEDGE_BASE_API_KEY \
  AUTOMATION_API_BASE_URL \
  PROJECT_SYNC_API_BASE_URL \
  OA_AUTH_ALIAS \
  OA_AGENT_SSO_SHARED_SECRET \
  OA_AGENT_SSO_TTL_SECONDS \
  OA_AGENT_AUTOMATION_TOKEN \
  DATABASE_URL \
  AUTOMATION_EXPECTED_DATABASE_NAME \
  OA_SESSION_SECRET \
  OA_SESSION_VERIFY_MAX_AGE \
  AUTOMATION_MIGRATE_ON_START \
  AUTOMATION_MAINTENANCE_ENABLED \
  AUTOMATION_MAINTENANCE_INTERVAL_SECONDS \
  AUTOMATION_MODEL_CATALOG_TTL_SECONDS \
  AUTOMATION_MODEL_CATALOG_STALE_SECONDS \
  AUTOMATION_SCHEDULE_GRACE_SECONDS \
  AUTOMATION_MANUAL_TRIGGER_LIMIT \
  AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS \
  OA_PROJECT_SYNC_TOKEN \
  OA_PROJECT_SYNC_TOKEN_HEADER \
  OA_PROJECT_SYNC_TOKEN_PREFIX \
  PROJECT_PROGRESS_WORKER_INSTANCE \
  PROJECT_PROGRESS_LEASE_SECONDS \
  PROJECT_PROGRESS_HEARTBEAT_SECONDS \
  PROJECT_PROGRESS_GITHUB_CONCURRENCY \
  PROJECT_PROGRESS_GITHUB_MAX_BRANCHES \
  PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH \
  PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY \
  PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN \
  PROJECT_PROGRESS_GITHUB_APP_ID \
  PROJECT_PROGRESS_AGENT_CONCURRENCY \
  PROJECT_PROGRESS_OA_WRITE_CONCURRENCY \
  PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS \
  PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT \
  PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE \
  PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS \
  AGENT_BIND_ADDRESS \
  AGENT_PORT \
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
[[ "$oa_knowledge_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "OA_KNOWLEDGE_API_BASE_URL must be an HTTP(S) URL"
[[ "$DATABASE_URL" =~ ^mysql://[^[:space:]]+/[^[:space:]/]+$ ]] \
  || fail "DATABASE_URL must be a mysql:// URL with a database name"
if [[ -n "$automation_expected_database_name" ]]; then
  [[ "$automation_expected_database_name" =~ ^[A-Za-z0-9_]+$ ]] \
    || fail "AUTOMATION_EXPECTED_DATABASE_NAME contains unsupported characters"
  readonly database_url_without_query="${DATABASE_URL%%\?*}"
  readonly configured_database_name="${database_url_without_query##*/}"
  [[ "$configured_database_name" == "$automation_expected_database_name" ]] \
    || fail "DATABASE_URL must target $automation_expected_database_name, got $configured_database_name"
fi
[[ "$automation_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "AUTOMATION_API_BASE_URL must be an HTTP(S) URL"
[[ "$project_sync_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "PROJECT_SYNC_API_BASE_URL must be an HTTP(S) URL"
[[ "$nexttoken_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "NEXTTOKEN_API_BASE_URL must be an HTTP(S) URL"
[[ "$openrouter_api_base_url" =~ ^https?://[^[:space:]]+$ ]] \
  || fail "OPENROUTER_API_BASE_URL must be an HTTP(S) URL"
[[ "$oa_auth_alias" =~ ^[A-Za-z0-9_-]+$ ]] \
  || fail "OA_AUTH_ALIAS contains unsupported characters"
[[ "$oa_project_sync_token_header" =~ ^[A-Za-z0-9-]+$ ]] \
  || fail "OA_PROJECT_SYNC_TOKEN_HEADER contains unsupported characters"
(( ${#project_progress_worker_instance} >= 1 && ${#project_progress_worker_instance} <= 255 )) \
  || fail "PROJECT_PROGRESS_WORKER_INSTANCE must contain 1-255 characters"
[[ "$project_progress_lease_seconds" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_LEASE_SECONDS must be a number"
(( project_progress_lease_seconds >= 60 && project_progress_lease_seconds <= 600 )) \
  || fail "PROJECT_PROGRESS_LEASE_SECONDS must be between 60 and 600"
[[ "$project_progress_heartbeat_seconds" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_HEARTBEAT_SECONDS must be a number"
(( project_progress_heartbeat_seconds >= 10 && project_progress_heartbeat_seconds <= 300 )) \
  || fail "PROJECT_PROGRESS_HEARTBEAT_SECONDS must be between 10 and 300"
(( project_progress_heartbeat_seconds < project_progress_lease_seconds )) \
  || fail "PROJECT_PROGRESS_HEARTBEAT_SECONDS must be less than PROJECT_PROGRESS_LEASE_SECONDS"
[[ "$project_progress_github_app_id" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_APP_ID must be a number"
[[ "$project_progress_github_concurrency" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_CONCURRENCY must be a number"
(( project_progress_github_concurrency >= 1 && project_progress_github_concurrency <= 20 )) \
  || fail "PROJECT_PROGRESS_GITHUB_CONCURRENCY must be between 1 and 20"
[[ "$project_progress_github_max_branches" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_BRANCHES must be a number"
(( project_progress_github_max_branches >= 1 && project_progress_github_max_branches <= 10000 )) \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_BRANCHES must be between 1 and 10000"
[[ "$project_progress_github_max_commit_pages_per_branch" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH must be a number"
(( project_progress_github_max_commit_pages_per_branch >= 1 && project_progress_github_max_commit_pages_per_branch <= 1000 )) \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH must be between 1 and 1000"
[[ "$project_progress_github_max_requests_per_repository" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY must be a number"
(( project_progress_github_max_requests_per_repository >= 1 && project_progress_github_max_requests_per_repository <= 100000 )) \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY must be between 1 and 100000"
[[ "$project_progress_github_max_requests_per_run" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN must be a number"
(( project_progress_github_max_requests_per_run >= 1 && project_progress_github_max_requests_per_run <= 1000000 )) \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN must be between 1 and 1000000"
(( project_progress_github_max_requests_per_repository <= project_progress_github_max_requests_per_run )) \
  || fail "PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY must not exceed PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN"
[[ "$project_progress_agent_concurrency" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_AGENT_CONCURRENCY must be a number"
(( project_progress_agent_concurrency >= 1 && project_progress_agent_concurrency <= 4 )) \
  || fail "PROJECT_PROGRESS_AGENT_CONCURRENCY must be between 1 and 4"
[[ "$project_progress_oa_write_concurrency" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_OA_WRITE_CONCURRENCY must be a number"
(( project_progress_oa_write_concurrency >= 1 && project_progress_oa_write_concurrency <= 20 )) \
  || fail "PROJECT_PROGRESS_OA_WRITE_CONCURRENCY must be between 1 and 20"
[[ "$project_progress_agent_max_detail_calls" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS must be a number"
(( project_progress_agent_max_detail_calls >= 1 && project_progress_agent_max_detail_calls <= 50 )) \
  || fail "PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS must be between 1 and 50"
[[ "$project_progress_agent_max_files_per_commit" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT must be a number"
(( project_progress_agent_max_files_per_commit >= 1 && project_progress_agent_max_files_per_commit <= 100 )) \
  || fail "PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT must be between 1 and 100"
[[ "$project_progress_agent_max_patch_chars_per_file" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE must be a number"
(( project_progress_agent_max_patch_chars_per_file >= 100 && project_progress_agent_max_patch_chars_per_file <= 20000 )) \
  || fail "PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE must be between 100 and 20000"
[[ "$project_progress_agent_max_total_patch_chars" =~ ^[0-9]+$ ]] \
  || fail "PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS must be a number"
(( project_progress_agent_max_total_patch_chars >= 100 && project_progress_agent_max_total_patch_chars <= 100000 )) \
  || fail "PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS must be between 100 and 100000"
(( project_progress_agent_max_total_patch_chars >= project_progress_agent_max_patch_chars_per_file )) \
  || fail "PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS must not be less than the per-file patch limit"
[[ "$OA_AGENT_SSO_TTL_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || fail "OA_AGENT_SSO_TTL_SECONDS must be a positive integer"
[[ "$oa_session_verify_max_age" =~ ^[0-9]+$ ]] \
  || fail "OA_SESSION_VERIFY_MAX_AGE must be a non-negative integer"
[[ "$automation_migrate_on_start" =~ ^(true|false)$ ]] \
  || fail "AUTOMATION_MIGRATE_ON_START must be true or false"
[[ "$automation_maintenance_enabled" =~ ^(true|false)$ ]] \
  || fail "AUTOMATION_MAINTENANCE_ENABLED must be true or false"
[[ "$automation_maintenance_interval_seconds" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_MAINTENANCE_INTERVAL_SECONDS must be a number"
(( automation_maintenance_interval_seconds >= 5 && automation_maintenance_interval_seconds <= 3600 )) \
  || fail "AUTOMATION_MAINTENANCE_INTERVAL_SECONDS must be between 5 and 3600"
[[ "$automation_model_catalog_ttl_seconds" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_MODEL_CATALOG_TTL_SECONDS must be a number"
(( automation_model_catalog_ttl_seconds >= 1 && automation_model_catalog_ttl_seconds <= 86400 )) \
  || fail "AUTOMATION_MODEL_CATALOG_TTL_SECONDS must be between 1 and 86400"
[[ "$automation_model_catalog_stale_seconds" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_MODEL_CATALOG_STALE_SECONDS must be a number"
(( automation_model_catalog_stale_seconds >= 1 && automation_model_catalog_stale_seconds <= 31536000 )) \
  || fail "AUTOMATION_MODEL_CATALOG_STALE_SECONDS must be between 1 and 31536000"
[[ "$automation_schedule_grace_seconds" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_SCHEDULE_GRACE_SECONDS must be a number"
[[ "$automation_manual_trigger_limit" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_MANUAL_TRIGGER_LIMIT must be a number"
[[ "$automation_manual_trigger_window_seconds" =~ ^[0-9]+$ ]] \
  || fail "AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS must be a number"
[[ "$agent_bind_address" =~ ^[A-Za-z0-9:._-]+$ ]] \
  || fail "AGENT_BIND_ADDRESS contains unsupported characters"
[[ "$AGENT_PORT" =~ ^[0-9]+$ ]] \
  || fail "AGENT_PORT must be a number"
(( AGENT_PORT >= 1 && AGENT_PORT <= 65535 )) \
  || fail "AGENT_PORT must be between 1 and 65535"
[[ "$web_bind_address" =~ ^[A-Za-z0-9:._-]+$ ]] \
  || fail "WEB_BIND_ADDRESS contains unsupported characters"
[[ "$WEB_PORT" =~ ^[0-9]+$ ]] \
  || fail "WEB_PORT must be a number"
(( WEB_PORT >= 1 && WEB_PORT <= 65535 )) \
  || fail "WEB_PORT must be between 1 and 65535"
[[ "$AGENT_PORT" != "$WEB_PORT" ]] \
  || fail "AGENT_PORT and WEB_PORT must use different host ports"

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
  printf 'OA_KNOWLEDGE_API_BASE_URL=%s\n' "$oa_knowledge_api_base_url"
  printf 'OA_KNOWLEDGE_BASE_API_KEY=%s\n' "$OA_KNOWLEDGE_BASE_API_KEY"
  printf 'AUTOMATION_API_BASE_URL=%s\n' "$automation_api_base_url"
  printf 'PROJECT_SYNC_API_BASE_URL=%s\n' "$project_sync_api_base_url"
  printf 'OA_API_TOKEN_HEADER=Cookie\n'
  printf 'OA_API_TOKEN_PREFIX=sessionid=\n'
  printf 'OA_AUTH_ALIAS=%s\n' "$oa_auth_alias"
  printf 'OA_AGENT_SSO_SHARED_SECRET=%s\n' "$OA_AGENT_SSO_SHARED_SECRET"
  printf 'OA_AGENT_SSO_TTL_SECONDS=%s\n' "$OA_AGENT_SSO_TTL_SECONDS"
  printf 'OA_AGENT_AUTOMATION_TOKEN=%s\n' "$OA_AGENT_AUTOMATION_TOKEN"
  printf 'DATABASE_URL=%s\n' "$DATABASE_URL"
  printf 'OA_SESSION_SECRET=%s\n' "$OA_SESSION_SECRET"
  printf 'OA_SESSION_VERIFY_MAX_AGE=%s\n' "$oa_session_verify_max_age"
  printf 'AUTOMATION_MIGRATE_ON_START=%s\n' "$automation_migrate_on_start"
  printf 'AUTOMATION_MAINTENANCE_ENABLED=%s\n' "$automation_maintenance_enabled"
  printf 'AUTOMATION_MAINTENANCE_INTERVAL_SECONDS=%s\n' "$automation_maintenance_interval_seconds"
  printf 'AUTOMATION_MODEL_CATALOG_TTL_SECONDS=%s\n' "$automation_model_catalog_ttl_seconds"
  printf 'AUTOMATION_MODEL_CATALOG_STALE_SECONDS=%s\n' "$automation_model_catalog_stale_seconds"
  printf 'AUTOMATION_SCHEDULE_GRACE_SECONDS=%s\n' "$automation_schedule_grace_seconds"
  printf 'AUTOMATION_MANUAL_TRIGGER_LIMIT=%s\n' "$automation_manual_trigger_limit"
  printf 'AUTOMATION_MANUAL_TRIGGER_WINDOW_SECONDS=%s\n' "$automation_manual_trigger_window_seconds"
  printf 'OA_PROJECT_SYNC_TOKEN=%s\n' "$OA_PROJECT_SYNC_TOKEN"
  printf 'OA_PROJECT_SYNC_TOKEN_HEADER=%s\n' "$oa_project_sync_token_header"
  printf 'OA_PROJECT_SYNC_TOKEN_PREFIX=%s\n' "$oa_project_sync_token_prefix"
  printf 'PROJECT_PROGRESS_GITHUB_APP_ID=%s\n' "$project_progress_github_app_id"
  printf 'PROJECT_PROGRESS_GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/project-progress-github-app-private-key.pem\n'
  printf 'PROJECT_PROGRESS_WORKER_INSTANCE=%s\n' "$project_progress_worker_instance"
  printf 'PROJECT_PROGRESS_LEASE_SECONDS=%s\n' "$project_progress_lease_seconds"
  printf 'PROJECT_PROGRESS_HEARTBEAT_SECONDS=%s\n' "$project_progress_heartbeat_seconds"
  printf 'PROJECT_PROGRESS_WRITE_ENABLED=true\n'
  printf 'PROJECT_PROGRESS_PRODUCTION_WRITES=I_UNDERSTAND_PRODUCTION_WRITES\n'
  printf 'PROJECT_PROGRESS_STATE_DB=/app/.context/project-progress.sqlite\n'
  printf 'PROJECT_PROGRESS_WORKSPACE_ROOT=/app/.context/project-progress-workspaces\n'
  printf 'PROJECT_PROGRESS_GITHUB_CONCURRENCY=%s\n' "$project_progress_github_concurrency"
  printf 'PROJECT_PROGRESS_GITHUB_MAX_BRANCHES=%s\n' "$project_progress_github_max_branches"
  printf 'PROJECT_PROGRESS_GITHUB_MAX_COMMIT_PAGES_PER_BRANCH=%s\n' "$project_progress_github_max_commit_pages_per_branch"
  printf 'PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_REPOSITORY=%s\n' "$project_progress_github_max_requests_per_repository"
  printf 'PROJECT_PROGRESS_GITHUB_MAX_REQUESTS_PER_RUN=%s\n' "$project_progress_github_max_requests_per_run"
  printf 'PROJECT_PROGRESS_AGENT_CONCURRENCY=%s\n' "$project_progress_agent_concurrency"
  printf 'PROJECT_PROGRESS_OA_WRITE_CONCURRENCY=%s\n' "$project_progress_oa_write_concurrency"
  printf 'PROJECT_PROGRESS_MODEL_PROVIDER=nexttoken\n'
  printf 'PROJECT_PROGRESS_MODEL=gpt-5.6-terra\n'
  printf 'PROJECT_PROGRESS_MODEL_REASONING_EFFORT=medium\n'
  printf 'PROJECT_PROGRESS_MODEL_MAX_OUTPUT_TOKENS=1024\n'
  printf 'PROJECT_PROGRESS_AGENT_MAX_DETAIL_CALLS=%s\n' "$project_progress_agent_max_detail_calls"
  printf 'PROJECT_PROGRESS_AGENT_MAX_FILES_PER_COMMIT=%s\n' "$project_progress_agent_max_files_per_commit"
  printf 'PROJECT_PROGRESS_AGENT_MAX_PATCH_CHARS_PER_FILE=%s\n' "$project_progress_agent_max_patch_chars_per_file"
  printf 'PROJECT_PROGRESS_AGENT_MAX_TOTAL_PATCH_CHARS=%s\n' "$project_progress_agent_max_total_patch_chars"
  printf 'OA_USER_TOKEN_HEADER=Authorization\n'
  printf 'OA_USER_TOKEN_PREFIX=Bearer\n'
  printf 'AGENT_BIND_ADDRESS=%s\n' "$agent_bind_address"
  printf 'AGENT_PORT=%s\n' "$AGENT_PORT"
  printf 'WEB_BIND_ADDRESS=%s\n' "$web_bind_address"
  printf 'WEB_PORT=%s\n' "$WEB_PORT"
} > "$temp_path"

chmod 600 "$temp_path"
mv -f "$temp_path" "$output_path"
trap - EXIT
