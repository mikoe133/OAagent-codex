#!/usr/bin/env bash

set -Eeuo pipefail

function fail() {
  echo "[project-progress-timer] $*" >&2
  exit 1
}

readonly deploy_dir="${1:?usage: install-project-progress-timer.sh DEPLOY_DIR DEPLOY_USER}"
readonly deploy_user="${2:?deploy user is required}"

[[ "$deploy_dir" == /* && "$deploy_dir" =~ ^/[A-Za-z0-9_./-]+$ ]] \
  || fail "DEPLOY_DIR must be a simple absolute path"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || fail "DEPLOY_USER is invalid"
[[ -f "$deploy_dir/compose.yml" && -f "$deploy_dir/.env" && -f "$deploy_dir/.deploy.env" ]] \
  || fail "deployment files are incomplete in $deploy_dir"
getent passwd "$deploy_user" >/dev/null || fail "DEPLOY_USER does not exist"

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly unit_template="$repo_root/deploy/systemd/oa-agent-project-progress.service"
readonly timer_source="$repo_root/deploy/systemd/oa-agent-project-progress.timer"
readonly temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT

sed \
  -e "s|@DEPLOY_DIR@|$deploy_dir|g" \
  -e "s|@DEPLOY_USER@|$deploy_user|g" \
  "$unit_template" > "$temp_dir/oa-agent-project-progress.service"

sudo install -m 0644 \
  "$temp_dir/oa-agent-project-progress.service" \
  /etc/systemd/system/oa-agent-project-progress.service
sudo install -m 0644 \
  "$timer_source" \
  /etc/systemd/system/oa-agent-project-progress.timer
sudo systemctl daemon-reload
sudo systemctl enable --now oa-agent-project-progress.timer
sudo systemctl status --no-pager oa-agent-project-progress.timer
