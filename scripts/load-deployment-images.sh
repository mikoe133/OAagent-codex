#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_PORT:?DEPLOY_PORT is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
archive_dir="${1:?deployment archive directory is required}"
target="${DEPLOY_USER}@${DEPLOY_HOST}"
ssh_options=(-i "$HOME/.ssh/id_ed25519" -p "$DEPLOY_PORT"
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# Keep these budgets below the workflow's 60-minute step / 75-minute job limits.
# SSH keepalives detect dead connections, not a stalled transfer or Docker daemon.
transfer_budget=1200
load_budget=300
for command in timeout rsync sha256sum; do
  command -v "$command" >/dev/null || { echo "Required runner command: $command" >&2; exit 1; }
done
printf -v rsync_ssh '%q ' ssh "${ssh_options[@]}"

remote() {
  local budget="$1" command="$2"
  timeout --kill-after=10s "${budget}s" ssh "${ssh_options[@]}" "$target" bash -s <<< "$command"
}

# Validate both artifacts before making any remote changes.
for service in agent web; do
  archive="$archive_dir/$service.tar.gz"
  if [[ ! -f "$archive" ]]; then
    echo "Missing deployment image archive: $archive" >&2
    exit 1
  fi
  gzip -t "$archive"
done

cache_dir="$DEPLOY_PATH/.deployment-images"
printf -v quoted_cache '%q' "$cache_dir"
echo "Checking server Docker, transfer tools, and disk space"
remote 60 "set -e
for tool in rsync timeout sha256sum docker; do
  command -v \"\$tool\" >/dev/null || { echo \"Missing server tool: \$tool (install rsync/coreutils/docker before deployment)\" >&2; exit 1; }
done
umask 077
mkdir -p -- $quoted_cache
root=\$(timeout --kill-after=5s 30s docker info --format '{{.DockerRootDir}}')
df -h -- $quoted_cache \"\$root\"
df -i -- $quoted_cache \"\$root\"
"

for service in agent web; do
  archive="$archive_dir/$service.tar.gz"
  checksum="$(sha256sum "$archive")"
  checksum="${checksum%% *}"
  # Content-addressed partial files cannot be confused with a different release.
  remote_archive="$cache_dir/$service-$checksum.tar.gz"
  printf -v quoted_archive '%q' "$remote_archive"
  echo "Uploading $service archive ($(wc -c < "$archive" | tr -d ' ') bytes; budget ${transfer_budget}s)"
  transfer_started=$SECONDS
  for attempt in 1 2 3; do
    remaining=$((transfer_budget - SECONDS + transfer_started))
    if (( remaining <= 0 )); then
      echo "Upload budget exhausted for $service; partial archive retained for resume." >&2
      exit 124
    fi
    echo "Uploading $service (attempt $attempt/3, ${remaining}s remaining)"
    # rsync's I/O timeout detects stalls even when SSH still answers keepalives.
    # Do not compress again: the artifact is already gzip-compressed.
    if timeout --kill-after=10s "${remaining}s" rsync \
      --partial --append-verify --protect-args --timeout=120 --info=progress2 \
      -e "$rsync_ssh" -- "$archive" "$target:$remote_archive"; then
      break
    else
      status=$?
    fi
    # Network/partial-transfer failures can resume. Other failures (e.g. rsync's
    # file-I/O exit code 11) should fail immediately.
    if [[ ! "$status" =~ ^(10|12|23|30|35|124|255)$ || "$attempt" -eq 3 ]]; then
      echo "Failed to upload $service (exit $status); partial archive retained at $remote_archive." >&2
      exit "$status"
    fi
    echo "Upload interrupted for $service (exit $status); resuming in $((attempt * 5)) seconds." >&2
    sleep "$((attempt * 5))"
  done

  echo "Verifying $service archive on server"
  remote 120 "set -e
if printf '%s  %s\\n' '$checksum' $quoted_archive | sha256sum -c >/dev/null; then
  echo '$service checksum verified'
else
  echo '$service checksum mismatch; removing corrupt archive before the next retry' >&2
  rm -f -- $quoted_archive
  exit 1
fi"
  echo "Loading $service image from server disk (budget ${load_budget}s)"
  if remote "$((load_budget + 30))" "timeout --kill-after=10s ${load_budget}s docker load --input $quoted_archive"; then
    remote 30 "rm -f -- $quoted_archive"
    echo "Loaded $service image successfully"
  else
    status=$?
    echo "Failed to load $service from server disk (exit $status; 124 means timeout). Upload is complete; check Docker daemon logs, disk/inodes, and memory. Archive retained at $remote_archive." >&2
    exit "$status"
  fi
done
