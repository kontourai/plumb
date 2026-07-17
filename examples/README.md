# Examples

- `opentherapist-checks.mjs` — the reference **pure** checks script (app health +
  build SHA match, data-artifact integrity, DB reachability, data freshness).
  Note the shape: one OK/FAIL line per check, exit code = any-failure. Kept
  side-effect-free so it's safe to run anywhere.
- `checks-wrapper.sh` — a shell `CHECKS_CMD` wrapper for when a deployment needs
  more than the pure checker: functional/side-effecting calls (hit a cron
  endpoint) and soft (WARN, non-failing) checks, plus the pure checker. Shows the
  accumulate-into-`FAILED` / `exit "$FAILED"` shape that keeps the exit-code
  contract correct.
- `job-with-escalation.sh` — `plumb-escalate` used **standalone**: any scheduled
  job can route its own failures through the same guardrailed agent (one context
  name per failure mode), independent of the checks harness.
- Post-deploy hook: call `plumb-run` at the end of your deploy script so a
  deploy that breaks something summons its own fixer.
