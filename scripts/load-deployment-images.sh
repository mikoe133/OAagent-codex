#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_HOST:?DEPLOY_HOST is required}"
: "${DEPLOY_PORT:?DEPLOY_PORT is required}"
archive_dir="${1:?deployment archive directory is required}"
target="${DEPLOY_USER}@${DEPLOY_HOST}"
ssh_options=(-i "$HOME/.ssh/id_ed25519" -p "$DEPLOY_PORT"
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# Validate both artifacts before making any remote changes.
for service in agent web; do
  archive="$archive_dir/$service.tar.gz"
  if [[ ! -f "$archive" ]]; then
    echo "Missing deployment image archive: $archive" >&2
    exit 1
  fi
  gzip -t "$archive"
done

for service in agent web; do
  archive="$archive_dir/$service.tar.gz"
  for attempt in 1 2 3; do
    echo "Loading $service image (attempt $attempt/3)"
    # docker load accepts gzip directly. Each retry reopens the archive at byte 0;
    # loading the same immutable image again is safe after an ambiguous disconnect.
    if ssh "${ssh_options[@]}" "$target" docker load < "$archive"; then
      break
    else
      status=$?
    fi
    if [[ "$status" -ne 255 || "$attempt" -eq 3 ]]; then
      echo "Failed to load $service image (exit $status). Check SSH/server logs and Docker disk/memory availability." >&2
      exit "$status"
    fi
    echo "SSH disconnected while loading $service; retrying in $((attempt * 5)) seconds." >&2
    sleep "$((attempt * 5))"
  done
done
