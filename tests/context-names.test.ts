import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
