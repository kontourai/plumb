#!/bin/bash
# plumb-escalate is not only for the checks harness — it's a standalone primitive
# any scheduled job can call to route its own failures through the same
# guardrailed agent, with the same rate-limit guards (per-context cooldown, daily
# cap, per-context lock). Pass a distinct context name per failure mode so a
# flapping step doesn't drown out or dedupe against the others.
#
# This is the shape OpenTherapist's fortnightly data-refresh uses: one job, many
# sub-steps (NPPES download, ingest, each state-license mirror), each escalating
# under its own name.
set -uo pipefail
STACK="$HOME/infra/myapp"
export PLUMB_CONFIG="$STACK/plumb.config"        # so plumb-escalate finds REPO_URL/AGENT_CMD/guards
ESCALATE="$HOME/plumb/bin/plumb-escalate"
LOG="$STACK/refresh-$(date +%Y%m).log"; exec >>"$LOG" 2>&1

if ! curl -sfL "https://upstream.example/data.zip" -o /tmp/data.zip; then
  echo "FAIL: download"
  "$ESCALATE" "myapp-refresh (download)" "$LOG"     # context "myapp-refresh (download)"
  exit 1
fi

if ! ingest /tmp/data.zip; then
  echo "FAIL: ingest"
  "$ESCALATE" "myapp-refresh (ingest)" "$LOG"       # a different context — guarded independently
  exit 1
fi
echo "OK refresh"
