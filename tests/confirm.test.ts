import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureGitEnvironment } from "./git-environment.js";

// Compiled to dist/tests/, so the published bin is two levels up.
const plumbBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/plumb.mjs");

const findingText = "Deleting the open board leaves its page at the deleted URL.";

function confirmFixture(extraConfigLines: string[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-confirm-"));
  const agentWorkdir = path.join(root, "agent");
  const promptFile = path.join(root, "agent-prompt.txt");
  mkdirSync(agentWorkdir);
  // A pre-initialised workdir means no clone; the failed fetch is harmless.
  execFileSync("git", ["init", "-q", agentWorkdir], { env: fixtureGitEnvironment() });
  const finding = path.join(root, "finding.md");
  writeFileSync(finding, `${findingText}\n`);
  const configPath = path.join(root, "plumb.config");
  writeFileSync(configPath, [
    'REPO_URL="https://example.test/repo.git"',
    'CHECKS_CMD="exit 0"',
    `AGENT_WORKDIR="${agentWorkdir}"`,
    // The prompt is appended as the agent's last argument; keep it for asserts.
    `AGENT_CMD='record() { printf "%s" "$1" > "${promptFile}"; }; record'`,
    `LOG_FILE="${path.join(root, "checks.log")}"`,
    `PLUMB_STATE_DIR="${path.join(root, "state")}"`,
    ...extraConfigLines,
    "",
  ].join("\n"));
  const confirm = (repro: string, findingPath = finding) =>
    spawnSync(process.execPath, [plumbBin, "confirm", "board-delete", findingPath, repro], {
      encoding: "utf8",
      env: { ...process.env, PLUMB_CONFIG: configPath },
    });
  const prompt = () => (existsSync(promptFile) ? readFileSync(promptFile, "utf8") : undefined);
  const findingsLog = () => readFileSync(path.join(root, "checks-findings.log"), "utf8");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, finding, confirm, prompt, findingsLog, cleanup };
}

test("a failing repro confirms the finding and escalates it with the finding and repro output", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm("echo 'still on /boards/repro after delete'; exit 1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "plumb: board-delete reproduced (repro exit 1)");
    const prompt = fixture.prompt();
    assert.ok(prompt, "the agent ran");
    assert.match(prompt, /named "board-delete" failed/);
    assert.ok(prompt.includes(findingText), "the finding reached the agent");
    assert.ok(prompt.includes("still on /boards/repro after delete"), "the repro output reached the agent");
    assert.match(prompt, /confirmed because its repro command failed with exit 1/);
    assert.match(fixture.findingsLog(), /OUTCOME reproduced \(exit 1\)/);
  } finally {
    fixture.cleanup();
  }
});

test("a passing repro does not reproduce the finding and never runs the agent", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm("echo 'navigated home'; exit 0");
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout.trim(), "plumb: board-delete not-reproduced (repro exit 0)");
    assert.equal(fixture.prompt(), undefined);
    const log = fixture.findingsLog();
    assert.ok(log.includes(findingText));
    assert.match(log, /navigated home/);
    assert.match(log, /OUTCOME not-reproduced \(exit 0\)/);
  } finally {
    fixture.cleanup();
  }
});

test("a repro whose command is missing is inconclusive, not a confirmed defect", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm("plumb-test-no-such-command-4f1c --run");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /^plumb: board-delete inconclusive \(repro exited 127: the command could not be found or run\)/);
    assert.equal(fixture.prompt(), undefined);
    assert.match(fixture.findingsLog(), /OUTCOME inconclusive/);
  } finally {
    fixture.cleanup();
  }
});

test("a repro that exceeds PLUMB_REPRO_TIMEOUT_SECS is inconclusive", () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="1"']);
  try {
    const started = Date.now();
    const result = fixture.confirm("sleep 10; exit 1");
    assert.ok(Date.now() - started < 8_000, "the timeout stopped the repro");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /inconclusive \(repro timed out after 1s\)/);
    assert.equal(fixture.prompt(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a malformed PLUMB_REPRO_TIMEOUT_SECS is refused before the repro runs", () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="1e3"']);
  try {
    const marker = path.join(fixture.root, "repro-ran");
    const result = fixture.confirm(`touch ${marker}; exit 1`);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'plumb: PLUMB_REPRO_TIMEOUT_SECS must be a non-negative integer, got "1e3"');
    assert.equal(existsSync(marker), false);
    assert.equal(fixture.prompt(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a missing or empty finding file is an error, not a confirmation", () => {
  const fixture = confirmFixture();
  try {
    const missing = fixture.confirm("exit 1", path.join(fixture.root, "absent.md"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^plumb: ENOENT/);
    const empty = path.join(fixture.root, "empty.md");
    writeFileSync(empty, "  \n");
    const blank = fixture.confirm("exit 1", empty);
    assert.equal(blank.status, 1);
    assert.equal(blank.stderr.trim(), `plumb: finding file is empty: ${empty}`);
    assert.equal(fixture.prompt(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("a confirmed finding goes through the escalation guards", () => {
  const fixture = confirmFixture(['PLUMB_ESCALATE_DAILY_CAP="0"']);
  try {
    const result = fixture.confirm("exit 1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.prompt(), undefined);
    assert.match(
      readFileSync(path.join(fixture.root, "checks-escalations.log"), "utf8"),
      /SUPPRESS board-delete \(daily cap 0 reached\)/,
    );
  } finally {
    fixture.cleanup();
  }
});
