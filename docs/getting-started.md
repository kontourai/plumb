# Getting started

This guide takes you from an empty deployment to a scheduled `plumb run` that
calls a maintenance agent when a check fails. For what each piece does, read
[Concepts](concepts.md). For every key and option, read
[Reference](reference.md).

## Requirements

- Node.js 22 or newer (the package's `engines` field).
- `bash` and `git` on the machine that runs plumb. Plumb sources its config
  with bash, runs your checks with bash, and keeps the agent's clone with git.
- A headless agent command, such as `claude -p` or `codex exec`, that accepts a
  prompt as its last argument. The prompt tells the agent to open pull requests
  with `gh pr create` and to file issues, so the agent's environment needs
  access to your repository on GitHub.

## Install

Install plumb as a dependency of the deployment, so the version is pinned
there:

```bash
npm install @kontourai/plumb
```

The package provides the `plumb` command. Without a local install,
`npx @kontourai/plumb run` resolves it from the registry instead.

## Write a checks command

A checks command is any shell command that prints evidence and exits non-zero
when a hard check fails. Plumb does not care what language it is written in.
A minimal one:

```bash
#!/bin/bash
set -uo pipefail
FAILED=0
if curl --fail --silent --show-error http://localhost:3000/api/health; then
  echo "OK app-health"
else
  echo "FAIL app-health"
  FAILED=1
fi
exit "$FAILED"
```

[`examples/checks-wrapper.sh`](../examples/checks-wrapper.sh) shows a fuller
wrapper with hard checks, a soft warning that never fails the run, and a
separate pure checker. See [Examples](../examples/README.md) for the rest.

## Create the config

Copy [`plumb.config.example`](../plumb.config.example) next to the deployment,
not inside the plumb package, and fill in the five required keys:

```bash
REPO_URL="git@github.com:you/your-app.git"
CHECKS_CMD="node scripts/checks.mjs"
AGENT_WORKDIR="$HOME/agent-work/your-app"
AGENT_CMD="claude -p --dangerously-skip-permissions"
LOG_FILE="$HOME/.local/state/plumb/checks.log"
```

`AGENT_WORKDIR` must be a directory reserved for the agent. Plumb clones
`REPO_URL` there, and before each escalation that passes the guards it fetches
`origin` and, if the fetch succeeds, runs `git reset --hard origin/main`. Never
point it at the deployment checkout.

The file is bash: plumb loads it by sourcing it, so comments, quoting, and
`$HOME` expansion work as they do in a shell script. Point `PLUMB_CONFIG` at it:

```bash
export PLUMB_CONFIG="$HOME/infra/my-app/plumb.config"
```

## Run the checks once

```bash
plumb run
```

Plumb appends a header line and the checks command's output to `LOG_FILE`:

```text
=== 2026-07-18T07:15:00.000Z plumb checks
OK app-health
```

If the checks command exits non-zero, plumb escalates: it runs the agent in
`AGENT_WORKDIR` and appends the agent's output to the escalations log beside
`LOG_FILE` (`checks-escalations.log` for `checks.log`). `plumb run` still exits
zero, so a failing check never makes the scheduled job itself fail. It exits 1
only when it cannot start, for example when a required config key is missing.

## Schedule it

Run `plumb run` from cron, or use the systemd units in
[`systemd/`](../systemd/plumb-checks.service).
[`plumb-checks.service`](../systemd/plumb-checks.service) is a oneshot service
that sets `PLUMB_CONFIG` and runs the deployment's pinned
`node_modules/.bin/plumb run`, and
[`plumb-checks.timer`](../systemd/plumb-checks.timer) triggers it daily at
07:15. Replace `APP` in the service with your deployment directory.

## Tag deploys

At the end of a deployment, pass the deployed commit:

```bash
plumb run --context deploy="$DEPLOY_SHA"
```

If that run fails, the agent is told which commit just landed. When plumb has
recorded a different earlier deploy SHA and both commits exist in the agent's
clone, it also gets the git range and diffstat between them. The first deploy
run has no earlier SHA, so it gets neither. See
[Run context and deploy provenance](concepts.md#run-context-and-deploy-provenance).

## Escalate from your own jobs

Any job can hand its own failure log to the same guarded agent:

```bash
plumb escalate database-refresh /var/log/my-app/database-refresh.log
```

Give each failure mode its own context name so they do not share a cooldown.
[`examples/job-with-escalation.sh`](../examples/job-with-escalation.sh) shows a
cron job with two independently guarded steps.

## Next steps

- [Concepts](concepts.md) explains the guards that keep the agent from running
  too often.
- [Reference](reference.md) lists every config key, CLI form, file plumb
  writes, and the programmatic API.
