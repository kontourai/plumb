#!/bin/bash
# Example CHECKS_CMD wrapper. Replace the commands with deployment-specific checks.
set -uo pipefail
FAILED=0

hard_check() {
  local name="$1"; shift
  if "$@"; then
    echo "OK $name"
  else
    echo "FAIL $name"
    FAILED=1
  fi
}

soft_check() {
  local name="$1"; shift
  if ! "$@"; then
    echo "WARN $name (does not fail the run)"
  fi
}

# Functional hard check: observes the running application.
hard_check app-health curl --fail --silent --show-error "${APP_URL:-http://localhost:3000}/api/health"
# Side-effecting hard check: verifies a safe, idempotent maintenance command.
hard_check refresh-cache npm run refresh:cache
# Soft signal: useful evidence, but not an escalation trigger.
soft_check optional-upstream curl --fail --silent --show-error "${UPSTREAM_URL:-https://example.com}/health"
# Pure checker: aggregates detailed invariants and owns its own exit code.
hard_check pure-checker node scripts/checks.mjs

exit "$FAILED"
