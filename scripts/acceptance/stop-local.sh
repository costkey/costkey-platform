#!/usr/bin/env bash

# Stop one server/cluster retained by run-local.sh --keepalive/--inspect.
# Requires the exact state file printed by the runner; it never accepts a
# directory or broad workspace path as a cleanup target.

set -euo pipefail

state_file="${1:-}"
if [[ -z "$state_file" || "$state_file" != /tmp/costkey-acceptance-state-*.env || ! -f "$state_file" ]]; then
  echo "usage: scripts/acceptance/stop-local.sh /tmp/costkey-acceptance-state-<pid>.env" >&2
  exit 2
fi

pg_data=""
server_pid=""
server_pgid=""
pg_ctl_bin=""
while IFS='=' read -r key value; do
  case "$key" in
    pg_data) pg_data="$value" ;;
    server_pid) server_pid="$value" ;;
    server_pgid) server_pgid="$value" ;;
    pg_ctl) pg_ctl_bin="$value" ;;
  esac
done <"$state_file"

if [[ "$pg_data" != /tmp/costkey-acceptance-pg.* || ! -d "$pg_data" ]]; then
  echo "refusing to stop an unrecognised PostgreSQL data directory" >&2
  exit 2
fi
if [[ ! "$server_pid" =~ ^[0-9]+$ || ! -x "$pg_ctl_bin" ]]; then
  echo "refusing to stop malformed acceptance state" >&2
  exit 2
fi
shell_pgid="$(ps -o pgid= -p "$$" | tr -d ' ')"

stop_server_tree() {
  local pid="$1"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then return; fi
  while read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    stop_server_tree "$child_pid"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}

if [[ "$server_pgid" =~ ^[0-9]+$ && "$server_pgid" != "$shell_pgid" && "$server_pgid" != "0" ]]; then
  kill -- -"$server_pgid" 2>/dev/null || true
fi
if kill -0 "$server_pid" 2>/dev/null; then
  stop_server_tree "$server_pid"
  wait "$server_pid" 2>/dev/null || true
fi
"$pg_ctl_bin" -D "$pg_data" -m fast -w stop >/dev/null 2>&1 || true
rm -rf -- "$pg_data"
rm -f -- "$state_file"
echo "[acceptance] stopped and removed $pg_data"
