import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  const confirm = (repro: string, findingPath = finding, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [plumbBin, "confirm", "board-delete", findingPath, repro], {
      encoding: "utf8",
      env: { ...process.env, PLUMB_CONFIG: configPath, ...env },
    });
  const prompt = () => (existsSync(promptFile) ? readFileSync(promptFile, "utf8") : undefined);
  const findingsLog = () => readFileSync(path.join(root, "checks-findings.log"), "utf8");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, finding, confirm, prompt, findingsLog, cleanup };
}

const reproduced = 'echo reproduced > "$PLUMB_VERDICT_FILE"';
const notReproduced = 'echo not-reproduced > "$PLUMB_VERDICT_FILE"';

test("a repro that reports reproduced and fails confirms the finding and escalates it", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm(`echo 'still on /boards/repro after delete'; ${reproduced}; exit 1`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "plumb: board-delete reproduced (repro exit 1)");
    const prompt = fixture.prompt();
    assert.ok(prompt, "the agent ran");
    assert.match(prompt, /named "board-delete" failed/);
    assert.ok(prompt.includes(findingText), "the finding reached the agent");
    assert.ok(prompt.includes("still on /boards/repro after delete"), "the repro output reached the agent");
    assert.match(prompt, /repro reported "reproduced" and exited 1/);
    assert.match(fixture.findingsLog(), /OUTCOME reproduced \(verdict reproduced, exit 1\)/);
  } finally {
    fixture.cleanup();
  }
});

test("a repro that reports not-reproduced and passes never runs the agent", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm(`echo 'navigated home'; ${notReproduced}; exit 0`);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout.trim(), "plumb: board-delete not-reproduced (repro exit 0)");
    assert.equal(fixture.prompt(), undefined);
    const log = fixture.findingsLog();
    assert.ok(log.includes(findingText));
    assert.match(log, /navigated home/);
    assert.match(log, /OUTCOME not-reproduced \(verdict not-reproduced, exit 0\)/);
  } finally {
    fixture.cleanup();
  }
});

for (const [name, repro] of [
  ["a crashed harness that exits 1", `node -e 'throw new Error("browser executable missing")'`],
  ["a missing working directory", "cd /plumb-test-absent-directory-4f1c && exit 0"],
  ["a missing command", "plumb-test-no-such-command-4f1c --run"],
  ["a child killed by a signal inside the shell", `node -e 'process.kill(process.pid, "SIGTERM")'; exit $?`],
] as const) {
  test(`${name} without a verdict is inconclusive, not a confirmed defect`, () => {
    const fixture = confirmFixture();
    try {
      const result = fixture.confirm(repro);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /^plumb: board-delete inconclusive \(repro exited \d+ without writing a verdict to PLUMB_VERDICT_FILE\)/);
      assert.equal(fixture.prompt(), undefined);
    } finally {
      fixture.cleanup();
    }
  });
}

test("a verdict that disagrees with the exit status is inconclusive", () => {
  const fixture = confirmFixture();
  try {
    const claimsDefect = fixture.confirm(`${reproduced}; exit 0`);
    assert.equal(claimsDefect.status, 3, claimsDefect.stderr);
    assert.match(claimsDefect.stdout, /inconclusive \(repro verdict "reproduced" does not match exit 0\)/);
    const claimsPass = fixture.confirm(`${notReproduced}; exit 1`);
    assert.equal(claimsPass.status, 3, claimsPass.stderr);
    assert.equal(fixture.prompt(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("the timeout is a hard deadline that also stops the repro's descendants", () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="1"']);
  try {
    const late = path.join(fixture.root, "descendant-survived");
    const started = Date.now();
    const result = fixture.confirm(
      `(sleep 3; touch ${late}) & trap '' TERM; while :; do sleep 0.1; done`,
    );
    assert.ok(Date.now() - started < 3_000, "the deadline held against a shell that ignores SIGTERM");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /inconclusive \(repro timed out after 1s\)/);
    spawnSync("sleep", ["3"]);
    assert.equal(existsSync(late), false, "the background child was killed with the group");
    assert.equal(fixture.prompt(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("processes a repro leaves behind are stopped when it exits", () => {
  const fixture = confirmFixture();
  try {
    const late = path.join(fixture.root, "leftover-survived");
    const result = fixture.confirm(`(sleep 2; touch ${late}) & ${notReproduced}; exit 0`);
    assert.equal(result.status, 2, result.stderr);
    spawnSync("sleep", ["3"]);
    assert.equal(existsSync(late), false);
  } finally {
    fixture.cleanup();
  }
});

test("escalation evidence is this run's record even if the findings log changes meanwhile", () => {
  const fixture = confirmFixture();
  try {
    // Workspace preparation runs git; this shim appends another run's record
    // to the shared findings log at that moment, as a concurrent confirm would.
    const shimDirectory = path.join(fixture.root, "shim");
    mkdirSync(shimDirectory);
    const shim = path.join(shimDirectory, "git");
    writeFileSync(shim, `#!/bin/sh\nprintf '=== other run\\nOTHER-RUN-MARKER\\nOUTCOME not-reproduced\\n' >> "${path.join(fixture.root, "checks-findings.log")}"\nexit 1\n`);
    spawnSync("chmod", ["+x", shim]);
    const result = fixture.confirm(`${reproduced}; exit 1`, fixture.finding, {
      PATH: `${shimDirectory}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const prompt = fixture.prompt() ?? "";
    assert.ok(prompt.includes(findingText));
    assert.ok(!prompt.includes("OTHER-RUN-MARKER"), "another run's record did not replace this one");
    assert.match(fixture.findingsLog(), /OTHER-RUN-MARKER/);
  } finally {
    fixture.cleanup();
  }
});

test("a long repro command cannot push the finding out of the evidence", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm(`# ${"x".repeat(5_000)}\n${reproduced}; exit 1`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((fixture.prompt() ?? "").includes(findingText));
  } finally {
    fixture.cleanup();
  }
});

test("the output tail keeps stdout and stderr in the order they were written", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm(
      `node -e 'process.stderr.write("E".repeat(2400))'; echo FINAL_ASSERTION_FAILURE; ${reproduced}; exit 1`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok((fixture.prompt() ?? "").includes("FINAL_ASSERTION_FAILURE"));
  } finally {
    fixture.cleanup();
  }
});

for (const [name, signal] of [["SIGTERM", "TERM"], ["SIGKILL", "KILL"]] as const) {
  test(`a supervisor killed with ${name} still stops the repro's process group`, () => {
    const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="30"']);
    try {
      const late = path.join(fixture.root, "descendant-survived");
      // The repro shell's parent is the supervisor.
      const result = fixture.confirm(`(sleep 2; touch ${late}) & kill -${signal} $PPID; sleep 5; ${reproduced}; exit 1`);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stdout, /inconclusive \(repro supervisor failed: supervisor exited/);
      spawnSync("sleep", ["3"]);
      assert.equal(existsSync(late), false, "the repro's group outlived its supervisor");
      assert.equal(fixture.prompt(), undefined);
    } finally {
      fixture.cleanup();
    }
  });
}

test("Ctrl-C to plumb's process group also stops the detached repro", async () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="30"']);
  try {
    const started = path.join(fixture.root, "repro-started");
    const late = path.join(fixture.root, "descendant-survived");
    // plumb and its supervisor share a foreground group, as in a terminal; the
    // repro runs in its own group and never sees the SIGINT.
    const cli = spawn(process.execPath, [plumbBin, "confirm", "board-delete", fixture.finding,
      `touch ${started}; (sleep 3; touch ${late}) & sleep 20`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PLUMB_CONFIG: path.join(fixture.root, "plumb.config") },
    });
    const exited = new Promise((resolve) => cli.on("exit", resolve));
    for (let waited = 0; !existsSync(started) && waited < 10_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(started), "the repro started");
    process.kill(-cli.pid!, "SIGINT");
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(existsSync(late), false, "the repro's group outlived an interrupted plumb");
  } finally {
    fixture.cleanup();
  }
});

test("a FIFO at the verdict path is refused instead of blocking", () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="5"']);
  try {
    const started = Date.now();
    const result = fixture.confirm('mkfifo "$PLUMB_VERDICT_FILE"; exit 0');
    assert.ok(Date.now() - started < 4_000, "reading the verdict did not block");
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /inconclusive \(verdict file is not a regular file\)/);
  } finally {
    fixture.cleanup();
  }
});

test("a symlinked verdict file is refused", () => {
  const fixture = confirmFixture();
  try {
    const target = path.join(fixture.root, "elsewhere");
    writeFileSync(target, "not-reproduced\n");
    const result = fixture.confirm(`ln -s ${target} "$PLUMB_VERDICT_FILE"; exit 0`);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /inconclusive \(verdict file could not be opened \(ELOOP\)\)/);
  } finally {
    fixture.cleanup();
  }
});

test("output beyond the capture limit makes the run inconclusive", () => {
  const fixture = confirmFixture();
  try {
    const result = fixture.confirm(`head -c 70000000 /dev/zero; ${notReproduced}; exit 0`);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /inconclusive \(repro output exceeded 67108864 bytes\)/);
  } finally {
    fixture.cleanup();
  }
});

test("a timeout beyond what a timer can hold is refused before the repro runs", () => {
  const fixture = confirmFixture(['PLUMB_REPRO_TIMEOUT_SECS="2000001"']);
  try {
    const marker = path.join(fixture.root, "repro-ran");
    const result = fixture.confirm(`touch ${marker}; ${notReproduced}; exit 0`);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "plumb: PLUMB_REPRO_TIMEOUT_SECS must be at most 2000000, got 2000001");
    assert.equal(existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

for (const key of ["PLUMB_REPRO_TIMEOUT_SECS", "PLUMB_ESCALATE_DAILY_CAP", "PLUMB_ESCALATE_COOLDOWN_SECS"]) {
  test(`a malformed ${key} is refused before the repro runs`, () => {
    const fixture = confirmFixture([`${key}="1e3"`]);
    try {
      const marker = path.join(fixture.root, "repro-ran");
      const result = fixture.confirm(`touch ${marker}; ${notReproduced}; exit 0`);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), `plumb: ${key} must be a non-negative integer, got "1e3"`);
      assert.equal(existsSync(marker), false);
      assert.equal(fixture.prompt(), undefined);
    } finally {
      fixture.cleanup();
    }
  });
}

test("a missing or empty finding file is an error, not a confirmation", () => {
  const fixture = confirmFixture();
  try {
    const missing = fixture.confirm(`${reproduced}; exit 1`, path.join(fixture.root, "absent.md"));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^plumb: ENOENT/);
    const empty = path.join(fixture.root, "empty.md");
    writeFileSync(empty, "  \n");
    const blank = fixture.confirm(`${reproduced}; exit 1`, empty);
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
    const result = fixture.confirm(`${reproduced}; exit 1`);
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
