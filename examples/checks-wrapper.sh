#!/bin/bash
# Example CHECKS_CMD wrapper (shell). Point plumb.config's CHECKS_CMD at this.
#
# Two things a pure checker (examples/opentherapist-checks.mjs) shouldn't own but
# a deployment often needs:
#   1. FUNCTIONAL calls with side effects (hit a cron endpoint, warm a cache) —
#      keep these out of the pure checker so it stays safe to run anywhere.
#   2. SOFT checks that should WARN, not fail the run.
#
# The contract plumb relies on: print one OK/FAIL/WARN line per check and exit
# non-zero IFF a *hard* check failed. That exit code is the only thing plumb
# escalates on — get it wrong (e.g. exit 0 on the failure path) and failures go
# unnoticed, or exit non-zero on the healthy path and you escalate every night.
# The accumulate-into-FAILED / `exit "$FAILED"` shape below makes it hard to get
# wrong: soft checks never touch FAILED, hard checks set it, nothing swallows it.
set -uo pipefail
FAILED=0

# 1. Functional, hard: a failure here fails the run.
if OUT=$(curl -fsS -m 30 "http://localhost:3030/api/cron/expiry"); then
  echo "OK cron-expiry ${OUT}"
else
  echo "FAIL cron-expiry endpoint error"; FAILED=1
fi

# 2. Functional, soft: warn but don't fail (e.g. an advisory job).
if OUT=$(curl -fsS -m 30 "http://localhost:3030/api/cron/screening"); then
  echo "OK cron-screening ${OUT}"
else
  echo "WARN cron-screening endpoint error (soft — not failing checks)"
fi

# 3. The pure checker (app health, data integrity, freshness) — hard.
node "$(dirname "$0")/opentherapist-checks.mjs" || FAILED=1

exit "$FAILED"
