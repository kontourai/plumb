# @kontourai/plumb

*The surveyor's plumb line: checks that things are true — and calls in repairs
when they aren't.*

Plumb is a small, dependency-free TypeScript package for self-healing deployment
checks. You supply a shell command that reports success or failure. Plumb logs
the result and, on failure, invokes a guardrailed AI agent in its own clean clone
to diagnose the problem and open a PR or issue. The deploy checkout and
production data remain outside the agent's working boundary.

Born inside [OpenTherapist](https://github.com/briananderson1222/opentherapist),
where its first live firing found two real deployment bugs.

## Install and run

```bash
npm install @kontourai/plumb
PLUMB_CONFIG=/path/to/deployment/plumb.config npx @kontourai/plumb run
```

With a local dependency, the same CLI is available directly:

```bash
plumb run
plumb escalate database-refresh /var/log/my-app/database-refresh.log
```

`plumb run` always exits zero. A failed `CHECKS_CMD` triggers escalation as a
side effect; suppression guards or agent outcomes do not turn the scheduled
check runner into a failing job.

## Configuration

Start from [`plumb.config.example`](plumb.config.example). It is a bash key/value
file, so quoting, comments, `$HOME` expansion, and existing shell expressions
continue to work. Plumb loads it by sourcing it in bash.

Your `plumb.config` belongs **with the deployment**, not inside the plumb
package or repository. Point `PLUMB_CONFIG` at that file in the environment or
in a systemd `Environment=` line:

```bash
export PLUMB_CONFIG="$HOME/infra/my-app/plumb.config"
```

The required keys are:

- `REPO_URL`: repository cloned for the maintenance agent.
- `CHECKS_CMD`: shell command that exits non-zero when any hard check fails.
- `AGENT_WORKDIR`: dedicated agent clone, never the deployment checkout.
- `AGENT_CMD`: headless agent command.
- `LOG_FILE`: append-only checks log; escalation output uses the corresponding
  `-escalations.log` file.
- `CONTEXT_DOCS`: optional docs the agent should read first.

Escalation guards are tunable through the config or environment:

- `PLUMB_ESCALATE_COOLDOWN_SECS` defaults to `21600` (6 hours) per context.
- `PLUMB_ESCALATE_DAILY_CAP` defaults to `8` across all contexts.
- `PLUMB_STATE_DIR` defaults to a `state` directory beside `LOG_FILE`.

## Escalate from any job

`plumb escalate <context> <log>` is a standalone primitive. Any cron job,
timer, or deployment step can route its own failure evidence through the same
per-context lock, cooldown, global daily cap, clean clone, and guardrailed
agent. Give each failure mode a distinct context name so unrelated jobs do not
share cooldown state:

```bash
plumb escalate database-refresh /var/log/my-app/database-refresh.log
plumb escalate search-reindex /var/log/my-app/search-reindex.log
```

See [`examples/job-with-escalation.sh`](examples/job-with-escalation.sh) for a
complete two-step cron-job pattern.

## Programmatic API

```ts
import { escalate, loadConfig, run } from "@kontourai/plumb";

const config = loadConfig(process.env.PLUMB_CONFIG);
run(config);
escalate("custom-job", "/var/log/custom-job.log", config);
```

## The contract

1. Checks may be written in any language. They should print useful evidence
   and exit non-zero if any hard check fails.
2. `plumb run` appends the check output and escalates failures.
3. The escalator resets a dedicated clone to `origin/main`, gives the last
   4000 log bytes to the configured agent, and enforces lock, cooldown, and
   daily-cap guards before expensive work.
4. The agent prompt forbids production-data writes, commits to main,
   force-pushes, and secret-file changes. Confident fixes become unmerged PRs;
   uncertain or environmental diagnoses become issues.

## Why an agent and not a pager

A pager tells you at 7am that something broke. Plumb's agent has already read
the logs, bisected the cause, and opened a PR with a failing-case explanation —
or an issue explaining why it didn't act. You review diffs over coffee instead
of tailing logs in a bathrobe. The guardrails (own clone, no-main, no-prod-data,
PR-only) mean the worst case of a wrong diagnosis is a closed PR.
