# Examples

- `opentherapist-checks.mjs` — the reference checks script (app health + build
  SHA match, data-artifact integrity, DB reachability, data freshness). Note
  the shape: one OK/FAIL line per check, exit code = any-failure.
- Post-deploy hook: call `plumb-run` at the end of your deploy script so a
  deploy that breaks something summons its own fixer.
