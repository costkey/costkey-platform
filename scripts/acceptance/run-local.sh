#!/usr/bin/env bash

# Run the CostKey acceptance probes against a disposable local PostgreSQL
# cluster and a local TypeScript server. This script is intentionally
# self-contained: it does not source .env files, inherit DATABASE_URL, or
# contact providers, email, webhooks, GitHub, or deployment services.

set -euo pipefail

keepalive=0
runner_args=()
for argument in "$@"; do
  case "$argument" in
    --keepalive|--inspect) keepalive=1 ;;
    *) runner_args+=("$argument") ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
pg_bin_dir="/opt/homebrew/opt/postgresql@16/bin"
pg_ctl_bin="$pg_bin_dir/pg_ctl"
initdb_bin="$pg_bin_dir/initdb"
createdb_bin="$pg_bin_dir/createdb"
node_bin="$(command -v node)"
tsx_preflight="$repo_root/node_modules/tsx/dist/preflight.cjs"
tsx_loader="$repo_root/node_modules/tsx/dist/loader.mjs"

for binary in "$pg_ctl_bin" "$initdb_bin" "$createdb_bin"; do
  if [[ ! -x "$binary" ]]; then
    echo "[acceptance] missing PostgreSQL binary: $binary" >&2
    exit 2
  fi
done
if [[ -z "$node_bin" || ! -f "$tsx_preflight" || ! -f "$tsx_loader" ]]; then
  echo "[acceptance] missing local Node/tsx runtime (run npm ci first)" >&2
  exit 2
fi

pg_version="$($pg_ctl_bin --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
if [[ -z "$pg_version" || "$pg_version" -lt 16 ]]; then
  echo "[acceptance] PostgreSQL 16+ is required; found: $($pg_ctl_bin --version)" >&2
  exit 2
fi

find_free_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")process.exit(2);process.stdout.write(String(address.port));server.close();});'
}

pg_data="$(mktemp -d /tmp/costkey-acceptance-pg.XXXXXX)"
pg_log="$pg_data/postgres.log"
server_log="$pg_data/server.log"
pg_port="$(find_free_port)"
app_port="$(find_free_port)"
db_name="costkey_acceptance"
db_user="costkey_acceptance"
db_url="postgresql://${db_user}@127.0.0.1:${pg_port}/${db_name}"
base_url="http://127.0.0.1:${app_port}"
report_path="$repo_root/docs/implementation/acceptance-evidence.local.json"
state_file="/tmp/costkey-acceptance-state-$$.env"
server_pid=""
server_pgid=""
shell_pgid="$(ps -o pgid= -p "$$" | tr -d ' ')"
run_status=0

stop_server_tree() {
  local pid="$1"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then return; fi
  while read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    stop_server_tree "$child_pid"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}

stop_server_group() {
  if [[ "$server_pgid" =~ ^[0-9]+$ && "$server_pgid" != "$shell_pgid" && "$server_pgid" != "0" ]]; then
    kill -- -"$server_pgid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    stop_server_tree "$server_pid"
    wait "$server_pid" 2>/dev/null || true
  fi
}

cleanup() {
  run_status=$?
  if [[ "$keepalive" -eq 1 && -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    printf 'pg_data=%s\nserver_pid=%s\nserver_pgid=%s\npg_ctl=%s\nserver_log=%s\nbase_url=%s\ndb_url=%s\npg_port=%s\napp_port=%s\nreport_path=%s\n' \
      "$pg_data" "$server_pid" "$server_pgid" "$pg_ctl_bin" "$server_log" "$base_url" "$db_url" "$pg_port" "$app_port" "$report_path" >"$state_file"
    trap - EXIT
    echo "[acceptance] keeping local server/DB alive for inspection"
    echo "[acceptance] browser URL: $base_url"
    echo "[acceptance] fixture owner login: owner@acceptance.invalid / acceptance-pass"
    echo "[acceptance] state: $state_file"
    echo "[acceptance] controlled cleanup: scripts/acceptance/stop-local.sh $state_file"
    exit "$run_status"
  fi
  stop_server_group
  if [[ -d "$pg_data" ]]; then
    "$pg_ctl_bin" -D "$pg_data" -m fast -w stop >/dev/null 2>&1 || true
    if [[ "$run_status" -ne 0 && -f "$server_log" ]]; then
      echo "[acceptance] server log tail (local only):" >&2
      tail -80 "$server_log" >&2 || true
    fi
    rm -rf -- "$pg_data"
  fi
  exit "$run_status"
}
trap cleanup EXIT

echo "[acceptance] initializing PostgreSQL $pg_version at 127.0.0.1:$pg_port (disposable)"
"$initdb_bin" -D "$pg_data" --username="$db_user" --auth-local=trust --auth-host=trust --no-locale >/dev/null
"$pg_ctl_bin" -D "$pg_data" -o "-p $pg_port -h 127.0.0.1" -l "$pg_log" -w start >/dev/null
"$createdb_bin" -h 127.0.0.1 -p "$pg_port" -U "$db_user" "$db_name"

# env -i is deliberate. Every process that can access the app receives only
# this explicit loopback DB URL and localhost app URL. No .env or production
# credential can leak into the server or runner.
echo "[acceptance] starting CostKey server at $base_url"
env -i \
  PATH="$PATH" \
  TMPDIR="/tmp" \
  LANG="C.UTF-8" \
  NODE_ENV="test" \
  PORT="$app_port" \
  DATABASE_URL="$db_url" \
  ACCEPTANCE_DATABASE_URL="$db_url" \
  ACCEPTANCE_BASE_URL="$base_url" \
  ACCEPTANCE_EXTERNAL_DELIVERY="disabled" \
  ACCEPTANCE_REPORT="$report_path" \
  COSTKEY_JWT_SECRET="local-acceptance-jwt" \
  COSTKEY_ADMIN_SECRET="local-acceptance-admin" \
  COSTKEY_NOTIFICATION_ENCRYPTION_KEY="local-acceptance-notification-key" \
  COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK="1" \
  RESEND_API_KEY="local-acceptance-disabled" \
  GITHUB_CLIENT_ID="" \
  GITHUB_CLIENT_SECRET="" \
  PUBLIC_URL="$base_url" \
  COSTKEY_RETENTION_DAYS="3650" \
  COSTKEY_NOTIFICATION_SINK="memory" \
  NODE_OPTIONS="--import=$repo_root/scripts/acceptance/network-deny.mjs" \
  "$node_bin" --require "$tsx_preflight" --import "$tsx_loader" packages/server/src/index.ts >"$server_log" 2>&1 &
server_pid=$!
server_pgid="$(ps -o pgid= -p "$server_pid" | tr -d ' ')"

# Health is intentionally available before application initialization. Wait
# for the explicit Ready hook so fixture writes never race migrations, seed,
# sourcemap loading, or cost backfills.
server_ready=0
for _ in $(seq 1 240); do
  if rg -q "\[costkey\] Ready" "$server_log" 2>/dev/null; then
    server_ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "[acceptance] CostKey server exited before Ready" >&2
    tail -120 "$server_log" >&2 || true
    exit 2
  fi
  sleep 0.25
done
if [[ "$server_ready" -ne 1 ]]; then
  echo "[acceptance] timed out waiting for CostKey server Ready" >&2
  tail -120 "$server_log" >&2 || true
  exit 2
fi

echo "[acceptance] running local HTTP/SDK/role probes (pass --strict to fail on incomplete routes)"
set +e
env -i \
  PATH="$PATH" \
  TMPDIR="/tmp" \
  LANG="C.UTF-8" \
  NODE_ENV="test" \
  DATABASE_URL="$db_url" \
  ACCEPTANCE_DATABASE_URL="$db_url" \
  ACCEPTANCE_BASE_URL="$base_url" \
  ACCEPTANCE_EXTERNAL_DELIVERY="disabled" \
  ACCEPTANCE_REPORT="$report_path" \
  COSTKEY_ADMIN_SECRET="local-acceptance-admin" \
  COSTKEY_JWT_SECRET="local-acceptance-jwt" \
  COSTKEY_NOTIFICATION_ENCRYPTION_KEY="local-acceptance-notification-key" \
  COSTKEY_NOTIFICATION_SINK="memory" \
  COSTKEY_NOTIFICATION_TEST_ALLOW_LOOPBACK="1" \
  NODE_OPTIONS="--import=$repo_root/scripts/acceptance/network-deny.mjs" \
  "$node_bin" --require "$tsx_preflight" --import "$tsx_loader" tests/acceptance/local-harness.ts "${runner_args[@]-}"
run_status=$?
set -e
if [[ "$run_status" -ne 0 ]]; then
  echo "[acceptance] runner exited $run_status; see $report_path when setup completed" >&2
fi
if [[ "$keepalive" -eq 1 ]]; then
  printf 'pg_data=%s\nserver_pid=%s\nserver_pgid=%s\npg_ctl=%s\nserver_log=%s\nbase_url=%s\ndb_url=%s\npg_port=%s\napp_port=%s\nreport_path=%s\n' \
    "$pg_data" "$server_pid" "$server_pgid" "$pg_ctl_bin" "$server_log" "$base_url" "$db_url" "$pg_port" "$app_port" "$report_path" >"$state_file"
  echo "[acceptance] keeping local server/DB alive for inspection"
  echo "[acceptance] browser URL: $base_url"
  echo "[acceptance] fixture owner login: owner@acceptance.invalid / acceptance-pass"
  echo "[acceptance] state: $state_file"
  echo "[acceptance] controlled cleanup: scripts/acceptance/stop-local.sh $state_file"
  # Keep this shell as the parent so the server is not reaped or sent SIGHUP
  # when the runner returns. Stop the server with stop-local.sh; this wait then
  # returns and the normal EXIT trap removes the disposable PostgreSQL cluster.
  wait "$server_pid" 2>/dev/null || true
  run_status=0
fi
exit "$run_status"
