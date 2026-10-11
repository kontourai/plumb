# Reference

The complete public surface of `@kontourai/plumb`: the `plumb` command, the
config file, the files plumb writes, and the programmatic API. For how the
pieces behave together, read [Concepts](concepts.md).

## CLI

```text
plumb run [--context <key>=<value>]
plumb escalate <context-name> <log-file>
```

Both commands load the config first (see [Configuration](#configuration)). Any
error, including a config error, is printed as `plumb: <message>` on stderr
with exit code 1.

### plumb run

Runs `CHECKS_CMD`, appends its output to `LOG_FILE`, and escalates under the
context name `checks` if it exits non-zero. See
[Check runner](concepts.md#check-runner).

`--context` takes exactly one `key=value` as a separate argument;
`--context=key=value` is not accepted. The `deploy` key records deploy
provenance (see
[Run context and deploy provenance](concepts.md#run-context-and-deploy-provenance)).
A malformed context is ignored with a warning.

Exits 0 once the config has loaded and the header line is written to
`LOG_FILE`, whatever the checks, guards, or agent do. Failing to create, open,
or write `LOG_FILE` exits 1.

### plumb escalate

Escalates the failure named `<context-name>`, using the last 4000 bytes of
`<log-file>` as evidence, through the same
[guards](concepts.md#escalation-guards) and agent as `plumb run`. Use a distinct
context name per failure mode so they do not share a lock or cooldown.

Exits 0 when the agent ran successfully and when a guard suppressed the
escalation. Exits 1 when the config is invalid, a guard setting is not a
non-negative integer, or the agent command fails.

### Usage and exit codes

| Invocation | Output | Exit |
| --- | --- | --- |
| no arguments, `--help`, `-h`, `--version` | usage on stdout | 0 |
| any other unrecognized form | usage on stderr | 1 |
| a command that throws | `plumb: <message>` on stderr | 1 |

`--version` prints the usage text, not a version number.

## Configuration

The config is a bash file. Plumb loads it with
`bash -c 'set -a; source "$1"; env -0'`, so every assignment is exported and
bash handles quoting, comments, expansion, and command substitution. Start from
[`plumb.config.example`](../plumb.config.example).

### Config file location

The CLI reads the file named by the `PLUMB_CONFIG` environment variable. If
`PLUMB_CONFIG` is unset, it falls back to `plumb.config` at the root of the
installed package, which normally does not exist; keep your config with the
deployment and set `PLUMB_CONFIG`.

Because bash inherits plumb's environment, a key that is already set in the
environment counts as configured even when the file does not set it.

### Configuration keys

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `REPO_URL` | yes | | Repository cloned into `AGENT_WORKDIR`. |
| `CHECKS_CMD` | yes | | Shell command that exits non-zero when a hard check fails. |
| `AGENT_WORKDIR` | yes | | Dedicated clone for the agent. Reset to `origin/main` before each escalation; never the deployment checkout. |
| `AGENT_CMD` | yes | | Headless agent command. The prompt is appended as its last argument. |
| `LOG_FILE` | yes | | Append-only checks log. Also determines the escalations log and default state directory. |
| `CONTEXT_DOCS` | no | `the repo docs` | Text inserted into the prompt as the docs the agent reads first. |
| `PLUMB_STATE_DIR` | no | `state` beside `LOG_FILE` | Directory for lock, cooldown, counter, and `deploy-sha` files. |
| `PLUMB_ESCALATE_COOLDOWN_SECS` | no | `21600` | Per-context cooldown in seconds. Also the age after which a lock is treated as stale. |
| `PLUMB_ESCALATE_DAILY_CAP` | no | `8` | Escalations allowed per local day, across all contexts. |

A required key that is unset or empty fails with
`Missing required config key: <KEY>`. The two guard settings are converted
with JavaScript's `Number()`, and escalation fails with
`<KEY> must be a non-negative integer` when the result is not a non-negative
whole number. `Number()` accepts more than plain digits: surrounding spaces,
`1e3`, and `0x10` are accepted, and an empty value becomes `0`. So a guard key
that is set but empty, such as `PLUMB_ESCALATE_DAILY_CAP=""`, silently means
`0`. A daily cap of `0` suppresses every escalation. A cooldown of `0` disables
the cooldown and also lets any lock older than about a second be reclaimed as
stale, which in practice removes the per-context lock.

## Files written

| Path | Written by | Contents |
| --- | --- | --- |
| `LOG_FILE` | `plumb run` | `=== <timestamp> plumb checks[ context=<key>=<value>]` headers and checks output. |
| `LOG_FILE` with `.log` replaced by `-escalations.log` | escalations | Agent output and `<timestamp> SUPPRESS <context> (<reason>)` lines. |
| `<state>/lock-<context>` | escalations | Held while an escalation for the context runs. |
| `<state>/last-<context>[_3adeploy_3a<sha>]` | escalations | Unix time of the last escalation, for the cooldown. |
| `<state>/count-YYYYMMDD` | escalations | Number of escalations that day; deleted after three days. |
| `<state>/deploy-sha` | `plumb run --context deploy=<sha>` | The latest deploy SHA. |
| `AGENT_WORKDIR` | escalations | The agent's clone of `REPO_URL`. |

`<state>` is `PLUMB_STATE_DIR` or `state` beside `LOG_FILE`. In file names,
lowercase letters and digits of the context are kept and every other byte,
including `_` and uppercase letters, becomes `_` plus two lowercase hex digits:
`db-refresh` is `db_2drefresh` and `Checks` is `_43hecks`. Distinct context
names therefore never share files. Plumb creates the directories it needs.

## Programmatic API

```ts
import { escalate, loadConfig, run } from "@kontourai/plumb";

const config = loadConfig(process.env.PLUMB_CONFIG);
run(config, { context: `deploy=${process.env.DEPLOY_SHA}` });
escalate("custom-job", "/var/log/custom-job.log", config);
```

The package exports three functions and their types. All three are
synchronous.

### loadConfig

```ts
loadConfig(configPath?: string): PlumbConfig
```

Sources the file at `configPath` (default: `PLUMB_CONFIG`, else the package's
`plumb.config`) and returns a `PlumbConfig`. It has the required and optional
keys from [Configuration keys](#configuration-keys) that are set, plus
`environment`: every variable exported while sourcing, including those
inherited from plumb's own environment, which plumb passes to
the checks command and the agent. Throws on a missing required key.

### run

```ts
run(config: PlumbConfig, options?: RunOptions): number
```

The function behind `plumb run`. `RunOptions` has `context?: string` (the
`key=value` string) and `escalateOptions?: EscalateOptions`, passed through to
the escalation with three overrides. `run` always sets `deployContext` from
its own `context` (to `undefined` unless it is a valid `deploy` context), so a
`deployContext` in `escalateOptions` is ignored. When a valid `context` is
given, it also replaces `runContext` with that `key=value`, and a `deploy`
context replaces `guardSignature` with `deploy:<sha>`. Returns 0. It throws if `LOG_FILE` cannot be created, opened, or written;
escalation errors are swallowed.

### escalate

```ts
escalate(
  context: string,
  logPath: string,
  config: PlumbConfig,
  options?: EscalateOptions,
): EscalateResult
```

The function behind `plumb escalate`. Returns `{ escalated: true }` after the
agent runs, or `{ escalated: false, reason }` when a guard suppressed it, with
`reason` one of `already running`, `within <N>s cooldown`, or
`daily cap <N> reached`. Throws on an invalid guard setting or a failed agent
command.

`EscalateOptions`:

| Option | Type | Effect |
| --- | --- | --- |
| `runAgent` | `(input: RunAgentInput) => void` | Replaces the agent call. When set, plumb also skips cloning, fetching, and the deploy diffstat. `RunAgentInput` is `{ config, prompt, escalationLog }`. |
| `now` | `() => Date` | Clock used for guards and timestamps. |
| `deployContext` | `DeployContext` | `{ sha, previousSha? }`; adds deploy provenance to the prompt. |
| `guardSignature` | `string` | Keys the cooldown to `<context>:<signature>` while sharing the context's lock. `plumb run` uses `deploy:<sha>`. |
| `runContext` | `string` | Adds `Run context: <value>.` to the prompt when there is no `deployContext`. |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `plumb: Missing required config key: REPO_URL` | `PLUMB_CONFIG` is unset or points at the wrong file, or the file leaves a required key empty. A preceding `No such file or directory` line from bash names the path it tried. |
| `plumb: ignoring malformed context ...` | The `--context` value failed validation, for example a `deploy` value that is not 7 to 64 hex digits. The run continued without it. |
| Usage text and exit 1 | The arguments did not match a form above, such as `--context=deploy=...` or `plumb escalate` with one argument. |
| A check failed but no agent ran | Look for a `SUPPRESS` line in the escalations log: the lock, cooldown, or daily cap stopped it. |
| `plumb: Agent command exited with status <N>` | From `plumb escalate`: the agent ran and failed. Its output is in the escalations log. |
| `plumb: PLUMB_ESCALATE_DAILY_CAP must be a non-negative integer` | A guard setting is not a non-negative whole number, for example `abc` or `-1`. `plumb run` ignores this error and does not escalate. |
| Every escalation is suppressed with `daily cap 0 reached` | `PLUMB_ESCALATE_DAILY_CAP` is set to `0` or to an empty value, which plumb reads as `0`. |
| The agent did not see the latest commits | `git fetch origin` failed in `AGENT_WORKDIR`, so plumb skipped the reset. The fetch error is printed on plumb's stderr. |
