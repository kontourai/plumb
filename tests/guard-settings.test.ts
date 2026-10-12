import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureGitEnvironment } from "./git-environment.js";

// Compiled to dist/tests/, so the published bin is two levels up.
const plumbBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/plumb.mjs");

function cliFixture(extraConfigLines: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-guards-"));
  const stateDirectory = path.join(root, "state");
  const agentWorkdir = path.join(root, "agent");
  const marker = path.join(root, "agent-ran");
  mkdirSync(stateDirectory);
  // A pre-initialised workdir means no clone; the failed fetch is harmless.
  mkdirSync(agentWorkdir);
  execFileSync("git", ["init", "-q", agentWorkdir], { env: fixtureGitEnvironment() });
  const evidence = path.join(root, "evidence.log");
  writeFileSync(evidence, "failure evidence\n");
  const configPath = path.join(root, "plumb.config");
  writeFileSync(configPath, [
    'REPO_URL="https://example.test/repo.git"',
    'CHECKS_CMD="exit 1"',
    `AGENT_WORKDIR="${agentWorkdir}"`,
    `AGENT_CMD="echo ran >> ${marker}; true"`,
    `LOG_FILE="${path.join(root, "checks.log")}"`,
    `PLUMB_STATE_DIR="${stateDirectory}"`,
    ...extraConfigLines,
    "",
  ].join("\n"));
  const escalate = (context: string) => spawnSync(process.execPath, [plumbBin, "escalate", context, evidence], {
    encoding: "utf8",
    env: { ...process.env, PLUMB_CONFIG: configPath },
  });
  const escalationsLog = () => {
    const file = path.join(root, "checks-escalations.log");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const agentRuns = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
  return { root, stateDirectory, escalate, escalationsLog, agentRuns };
}

for (const key of ["PLUMB_ESCALATE_DAILY_CAP", "PLUMB_ESCALATE_COOLDOWN_SECS"]) {
  for (const value of ["", " 8 ", "1e3", "0x10", "-1", "abc"]) {
    test(`plumb escalate refuses ${key}=${JSON.stringify(value)} instead of guessing`, () => {
      const fixture = cliFixture([`${key}=${JSON.stringify(value)}`]);
      try {
        const result = fixture.escalate("foo");
        assert.equal(result.status, 1, result.stderr);
        assert.equal(
          result.stderr.trim(),
          `plumb: ${key} must be a non-negative integer, got ${JSON.stringify(value)}`,
        );
        assert.equal(fixture.agentRuns(), 0);
        assert.doesNotMatch(fixture.escalationsLog(), /SUPPRESS/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
}

test("plumb escalate accepts plain decimal guard settings", () => {
  const fixture = cliFixture(['PLUMB_ESCALATE_DAILY_CAP="1"', 'PLUMB_ESCALATE_COOLDOWN_SECS="60"']);
  try {
    const first = fixture.escalate("foo");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fixture.agentRuns(), 1);
    const second = fixture.escalate("bar");
    assert.equal(second.status, 0, second.stderr);
    assert.match(fixture.escalationsLog(), /SUPPRESS bar \(daily cap 1 reached\)/);
    assert.equal(fixture.agentRuns(), 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("with a cooldown of 0, a lock held by a live process still suppresses a second escalation", () => {
  const fixture = cliFixture(['PLUMB_ESCALATE_COOLDOWN_SECS="0"']);
  try {
    const lockPath = path.join(fixture.stateDirectory, "lock-foo");
    // This test process is alive for the whole check, like a running escalation.
    writeFileSync(lockPath, `${process.pid}:0:0.5`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, old, old);
    const result = fixture.escalate("foo");
    assert.equal(result.status, 0, result.stderr);
    assert.match(fixture.escalationsLog(), /SUPPRESS foo \(already running\)/);
    assert.equal(fixture.agentRuns(), 0);
    assert.equal(readFileSync(lockPath, "utf8"), `${process.pid}:0:0.5`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a lock left by a dead process is reclaimed once older than the cooldown", () => {
  const fixture = cliFixture(['PLUMB_ESCALATE_COOLDOWN_SECS="0"']);
  try {
    const exited = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(exited.status, 0);
    const lockPath = path.join(fixture.stateDirectory, "lock-foo");
    writeFileSync(lockPath, `${exited.pid}:0:0.5`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, old, old);
    const result = fixture.escalate("foo");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.agentRuns(), 1);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
