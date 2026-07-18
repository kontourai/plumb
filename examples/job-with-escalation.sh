#!/bin/bash
# Standalone cron job: each sub-step gets an independent plumb context guard.
set -uo pipefail
export PLUMB_CONFIG="${PLUMB_CONFIG:-$HOME/infra/APP/plumb.config}"
PLUMB_BIN="${PLUMB_BIN:-$HOME/infra/APP/node_modules/.bin/plumb}"
LOG_DIR="${LOG_DIR:-$HOME/.local/state/my-app}"
mkdir -p "$LOG_DIR"
FAILED=0

run_step() {
  local context="$1" log="$2"; shift 2
  if ! "$@" >>"$log" 2>&1; then
    "$PLUMB_BIN" escalate "$context" "$log"
    FAILED=1
  fi
}

run_step database-refresh "$LOG_DIR/database-refresh.log" npm run refresh:database
run_step search-reindex "$LOG_DIR/search-reindex.log" npm run reindex:search
exit "$FAILED"
