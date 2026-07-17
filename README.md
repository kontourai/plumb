# plumb

*The surveyor's plumb line: checks that things are true — and calls in repairs
when they aren't.*

Plumb is a tiny self-healing-deployment harness for solo operators and small
teams: you declare **checks**; plumb runs them on a timer; when one fails, a
**guardrailed AI agent** (Claude Code, Codex, or any CLI agent) is invoked in
**its own clone** of your repo to diagnose the failure and open a PR or issue —
never touching your deploy checkout or production data.

Born inside [OpenTherapist](https://github.com/briananderson1222/opentherapist)
(its reference deployment), where the first live firing caught two real bugs —
a container missing git and a cron sidecar whose clock reset on every deploy —
and the escalation agent correctly refused to act beyond its permissions.

## The contract

1. **Checks** are any executable that prints one line per check —
   `OK <name> <detail>` or `FAIL <name> <detail>` — and exits non-zero if any
   failed. Write them in anything; keep them fast and side-effect-free.
2. **plumb-run** executes your checks, logs the output, and on failure invokes
   the escalator with the check name and log path.
3. **plumb-escalate** maintains a dedicated agent workspace (a separate clone,
   reset to origin/main each run), then invokes your agent CLI with the
   evidence and a guardrail prompt:
   - never modify production data (read-only inspection),
   - never commit to main or force-push,
   - confident fix → branch `auto/fix-*`, push, open a PR (never merge),
   - uncertain → file/append an issue with the full diagnosis,
   - always end with a one-paragraph summary.

## Quickstart

```bash
cp plumb.config.example plumb.config     # repo URL, checks cmd, agent cmd
./bin/plumb-run                          # run checks once, escalate on FAIL
# install the timer (systemd user units):
cp systemd/plumb-checks.* ~/.config/systemd/user/ && systemctl --user enable --now plumb-checks.timer
```

Your `plumb.config` usually lives **with your deployment**, not inside this repo
— point plumb at it with `PLUMB_CONFIG=/path/to/plumb.config` (env, or the
systemd unit's `Environment=`). Both `plumb-run` and `plumb-escalate` honor it.

See `examples/` for the pure checks script, a shell `CHECKS_CMD` wrapper
(functional + soft checks), standalone escalation from any job, and a post-deploy
self-check hook (deploys that break something summon their own fixer).

## Escalate from any job

`plumb-escalate <context-name> <log-file>` is a standalone primitive — you don't
have to go through `plumb-run`. Any scheduled job can hand its own failure to the
same guardrailed agent, with the same guards (per-context cooldown, daily cap,
per-context lock):

```bash
export PLUMB_CONFIG=~/infra/myapp/plumb.config
if ! ingest data.zip; then
  ~/plumb/bin/plumb-escalate "myapp-refresh (ingest)" "$LOG"
fi
```

Give each failure mode a distinct context name so a flapping step is deduped on
its own cooldown rather than against the others. See `examples/job-with-escalation.sh`.

## Why an agent and not a pager

A pager tells you at 7am that something broke. Plumb's agent has already read
the logs, bisected the cause, and opened a PR with a failing-case explanation —
or an issue explaining why it didn't act. You review diffs over coffee instead
of tailing logs in a bathrobe. The guardrails (own clone, no-main, no-prod-data,
PR-only) mean the worst case of a wrong diagnosis is a closed PR.
