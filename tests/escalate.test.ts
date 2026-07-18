import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { escalate, type PlumbConfig, type RunAgentInput } from "../src/index.js";

function fixture(overrides: Partial<PlumbConfig> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-escalate-"));
  const logFile = path.join(root, "checks.log");
  const stateDirectory = path.join(root, "state");
  mkdirSync(stateDirectory);
  writeFileSync(logFile, "failure evidence\n");
  const config: PlumbConfig = {
    REPO_URL: "https://example.test/repo.git",
    CHECKS_CMD: "exit 0",
    AGENT_WORKDIR: path.join(root, "agent"),
    AGENT_CMD: "true",
    LOG_FILE: logFile,
    PLUMB_STATE_DIR: stateDirectory,
    PLUMB_ESCALATE_COOLDOWN_SECS: "21600",
    PLUMB_ESCALATE_DAILY_CAP: "8",
    ...overrides,
  };
  const calls: RunAgentInput[] = [];
  return {
    root,
    logFile,
    stateDirectory,
    config,
    calls,
    options: { runAgent: (input: RunAgentInput) => calls.push(input) },
  };
}

function realDeployFixture(value: ReturnType<typeof fixture>) {
  const gitEnvironment = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) {
    delete gitEnvironment[name];
  }
  const source = path.join(value.root, "source");
  mkdirSync(source);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: source, env: gitEnvironment });
  execFileSync("git", ["config", "user.name", "Plumb Test"], { cwd: source, env: gitEnvironment });
  execFileSync("git", ["config", "user.email", "plumb@example.test"], { cwd: source, env: gitEnvironment });
  writeFileSync(path.join(source, "app.txt"), "first\n");
  execFileSync("git", ["add", "app.txt"], { cwd: source, env: gitEnvironment });
  execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: source, env: gitEnvironment });
  const previousSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    env: gitEnvironment,
  }).trim();
  writeFileSync(path.join(source, "app.txt"), "first\nsecond\n");
  execFileSync("git", ["commit", "-q", "-am", "second"], { cwd: source, env: gitEnvironment });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    env: gitEnvironment,
  }).trim();
  const promptFile = path.join(value.root, "prompt.txt");
  const captureScript = path.join(value.root, "capture.mjs");
  writeFileSync(captureScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(promptFile)}, process.argv[2]);\n`);
  value.config.REPO_URL = source;
  value.config.AGENT_CMD = `${process.execPath} ${captureScript}`;
  return { previousSha, promptFile, sha };
}

test("cooldown suppresses a second escalation inside the configured window", () => {
  const value = fixture();
  try {
    assert.deepEqual(escalate("checks", value.logFile, value.config, value.options), { escalated: true });
    assert.deepEqual(escalate("checks", value.logFile, value.config, value.options), {
      escalated: false,
      reason: "within 21600s cooldown",
    });
    assert.equal(value.calls.length, 1);
    assert.match(readFileSync(path.join(value.root, "checks-escalations.log"), "utf8"), /SUPPRESS checks \(within 21600s cooldown\)/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("global daily cap suppresses after N distinct contexts", () => {
  const value = fixture({ PLUMB_ESCALATE_DAILY_CAP: "2" });
  try {
    assert.equal(escalate("one", value.logFile, value.config, value.options).escalated, true);
    assert.equal(escalate("two", value.logFile, value.config, value.options).escalated, true);
    assert.deepEqual(escalate("three", value.logFile, value.config, value.options), {
      escalated: false,
      reason: "daily cap 2 reached",
    });
    assert.equal(value.calls.length, 2);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("distinct contexts have independent cooldown guards", () => {
  const value = fixture();
  try {
    assert.equal(escalate("database", value.logFile, value.config, value.options).escalated, true);
    assert.equal(escalate("search", value.logFile, value.config, value.options).escalated, true);
    assert.equal(escalate("database", value.logFile, value.config, value.options).escalated, false);
    assert.equal(value.calls.length, 2);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("guard signatures re-arm cooldown without changing the prompt context", () => {
  const value = fixture();
  try {
    const first = { ...value.options, guardSignature: "deploy:1111111" };
    const second = { ...value.options, guardSignature: "deploy:2222222" };
    assert.equal(escalate("checks", value.logFile, value.config, first).escalated, true);
    assert.equal(escalate("checks", value.logFile, value.config, second).escalated, true);
    assert.match(value.calls[0]!.prompt, /named "checks" failed/);
    assert.match(value.calls[1]!.prompt, /named "checks" failed/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("deploy signatures share the base context lock", () => {
  const value = fixture();
  try {
    writeFileSync(path.join(value.stateDirectory, "lock-checks"), "another-owner");
    assert.deepEqual(escalate("checks", value.logFile, value.config, {
      ...value.options,
      guardSignature: "deploy:1111111",
    }), {
      escalated: false,
      reason: "already running",
    });
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("deploy escalation updates the base cooldown stamp for a following plain run", () => {
  const value = fixture();
  try {
    assert.equal(escalate("checks", value.logFile, value.config, {
      ...value.options,
      guardSignature: "deploy:1111111",
    }).escalated, true);
    assert.ok(readFileSync(path.join(value.stateDirectory, "last-checks"), "utf8"));
    assert.deepEqual(escalate("checks", value.logFile, value.config, value.options), {
      escalated: false,
      reason: "within 21600s cooldown",
    });
    assert.equal(value.calls.length, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("daily cap binds across different deploy signatures", () => {
  const value = fixture({ PLUMB_ESCALATE_DAILY_CAP: "1" });
  try {
    assert.equal(escalate("checks", value.logFile, value.config, {
      ...value.options,
      guardSignature: "deploy:1111111",
    }).escalated, true);
    assert.deepEqual(escalate("checks", value.logFile, value.config, {
      ...value.options,
      guardSignature: "deploy:2222222",
    }), {
      escalated: false,
      reason: "daily cap 1 reached",
    });
    assert.equal(value.calls.length, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("context slug replaces every non-alphanumeric character", () => {
  const value = fixture();
  try {
    escalate("db:nightly / west", value.logFile, value.config, value.options);
    assert.ok(readdirSync(value.stateDirectory).includes("last-db_nightly___west"));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("escalation log replaces only a trailing .log suffix", () => {
  const value = fixture();
  try {
    escalate("checks", value.logFile, value.config, value.options);
    escalate("checks", value.logFile, value.config, value.options);
    assert.equal(value.calls[0]?.escalationLog, path.join(value.root, "checks-escalations.log"));
    assert.match(readFileSync(path.join(value.root, "checks-escalations.log"), "utf8"), /SUPPRESS/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("agent receives the original guardrail prompt text with interpolated evidence", () => {
  const value = fixture({ CONTEXT_DOCS: "docs/RUNBOOK.md" });
  try {
    escalate("nightly", value.logFile, value.config, value.options);
    assert.equal(value.calls[0]?.prompt, `You are the on-call maintenance agent for this deployment.

An automated check or job named "nightly" failed. Evidence (log tail):
---
failure evidence
---

Diagnose the root cause. Read docs/RUNBOOK.md first. You may inspect services, containers, and logs, and run READ-ONLY queries against databases.

STRICT GUARDRAILS:
- Never modify or delete production data; SELECT-only against any database.
- Never commit to main, never force-push, never touch secrets files.
- Confident code/config fix: branch auto/fix-<short-name>, commit, push the branch, open a PR (gh pr create) describing cause and fix. Do NOT merge.
- Uncertain or environmental cause (disk, network, upstream outage): file an issue titled "[auto] nightly failing" with full diagnosis and recommendation — check for an existing open issue with that title first and comment instead of duplicating.
- End with a one-paragraph summary of what you did.`);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("real escalation computes a deploy diffstat in the clean agent clone", () => {
  const value = fixture();
  try {
    const { previousSha, promptFile, sha } = realDeployFixture(value);

    assert.equal(escalate("checks", value.logFile, value.config, {
      deployContext: { sha, previousSha },
    }).escalated, true);
    const prompt = readFileSync(promptFile, "utf8");
    assert.match(prompt, new RegExp(`This failure began immediately after deploy ${sha} — diff below`));
    assert.match(prompt, new RegExp(`${previousSha}\\.\\.${sha}`));
    assert.match(prompt, /app\.txt\s+\|\s+1 \+/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("real escalation ignores inherited Git hook context when computing deploy diffstat", () => {
  const value = fixture();
  const originalGitDir = process.env.GIT_DIR;
  try {
    const { previousSha, promptFile, sha } = realDeployFixture(value);
    process.env.GIT_DIR = path.join(value.root, "bogus-git-dir");
    assert.equal(escalate("checks", value.logFile, value.config, {
      deployContext: { sha, previousSha },
    }).escalated, true);
    assert.match(readFileSync(promptFile, "utf8"), /app\.txt\s+\|\s+1 \+/);
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("an active per-context lock suppresses without invoking the agent", () => {
  const value = fixture();
  try {
    writeFileSync(path.join(value.stateDirectory, "lock-checks"), "another-owner");
    assert.deepEqual(escalate("checks", value.logFile, value.config, value.options), {
      escalated: false,
      reason: "already running",
    });
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("a lock older than the cooldown is reclaimed and released", () => {
  const value = fixture({ PLUMB_ESCALATE_COOLDOWN_SECS: "60" });
  try {
    const lockPath = path.join(value.stateDirectory, "lock-checks");
    writeFileSync(lockPath, "dead-owner");
    const stale = new Date(Date.now() - 61_000);
    utimesSync(lockPath, stale, stale);
    assert.deepEqual(escalate("checks", value.logFile, value.config, value.options), { escalated: true });
    assert.equal(value.calls.length, 1);
    assert.equal(readdirSync(value.stateDirectory).includes("lock-checks"), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
