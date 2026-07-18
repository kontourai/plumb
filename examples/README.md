# Examples

- `opentherapist-checks.mjs` — the reference pure checker shape: one `OK` or
  `FAIL` line per check, with a non-zero exit if any check failed.
- `checks-wrapper.sh` — a `CHECKS_CMD` wrapper combining functional and
  side-effecting hard checks, a soft warning, and a pure checker while
  accumulating failures into one final exit code.
- `job-with-escalation.sh` — a cron-friendly job that calls `plumb escalate`
  directly for two independently guarded sub-step contexts.
- Post-deploy hook — run `plumb run --context deploy="$DEPLOY_SHA"` at the end
  of a deployment so a deploy that breaks a hard check summons a fixer with
  the deployed SHA and, when known, its prior-deploy diffstat.
