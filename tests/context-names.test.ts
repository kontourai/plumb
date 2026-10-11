import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Compiled to dist/tests/, so the published bin is two levels up.
const plumbBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/plumb.mjs");

test("plumb escalate keeps separate guards for names that differ only in punctuation or case", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-context-names-"));
  try {
    const agentWorkdir = path.join(root, "agent");
    const marker = path.join(root, "agent-ran");
    // A pre-initialised workdir means no clone; the failed fetch is harmless.
    mkdirSync(agentWorkdir);
    execFileSync("git", ["init", "-q", agentWorkdir]);
    const evidence = path.join(root, "evidence.log");
    writeFileSync(evidence, "failure evidence\n");
    const configPath = path.join(root, "plumb.config");
    writeFileSync(configPath, [
      'REPO_URL="https://example.test/repo.git"',
      'CHECKS_CMD="exit 1"',
      `AGENT_WORKDIR="${agentWorkdir}"`,
      `AGENT_CMD="echo ran >> ${marker}; true"`,
      `LOG_FILE="${path.join(root, "checks.log")}"`,
      `PLUMB_STATE_DIR="${path.join(root, "state")}"`,
      "",
    ].join("\n"));
    const names = ["a-b", "a_b", "a.b", "a b", "A-b"];
    for (const name of names) {
      const result = spawnSync(process.execPath, [plumbBin, "escalate", name, evidence], {
        encoding: "utf8",
        env: { ...process.env, PLUMB_CONFIG: configPath },
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const log = path.join(root, "checks-escalations.log");
    assert.doesNotMatch(existsSync(log) ? readFileSync(log, "utf8") : "", /SUPPRESS/);
    assert.equal(readFileSync(marker, "utf8").split("\n").filter(Boolean).length, names.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plumb escalate handles long punctuation-heavy names with distinct, bounded state files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-context-long-"));
  try {
    const agentWorkdir = path.join(root, "agent");
    const marker = path.join(root, "agent-ran");
    const stateDirectory = path.join(root, "state");
    mkdirSync(agentWorkdir);
    execFileSync("git", ["init", "-q", agentWorkdir]);
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
      "",
    ].join("\n"));
    // 140 characters encode to 280; these two differ only in their last character.
    const names = ["a-".repeat(70), `${"a-".repeat(69)}a_`];
    const escalate = (name: string) => spawnSync(process.execPath, [plumbBin, "escalate", name, evidence], {
      encoding: "utf8",
      env: { ...process.env, PLUMB_CONFIG: configPath },
    });
    for (const name of names) {
      const result = escalate(name);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(readFileSync(marker, "utf8").split("\n").filter(Boolean).length, 2);
    const repeat = escalate(names[0]!);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(readFileSync(path.join(root, "checks-escalations.log"), "utf8"), /SUPPRESS a-a-.* \(within 21600s cooldown\)/);
    const stamps = readdirSync(stateDirectory).filter((name) => name.startsWith("last-"));
    assert.equal(stamps.length, 2);
    for (const stamp of stamps) assert.ok(stamp.length <= 105, stamp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
