import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("run CLI accepts one context flag", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-cli-"));
  const oldConfig = process.env.PLUMB_CONFIG;
  try {
    const logFile = path.join(root, "checks.log");
    const configPath = path.join(root, "plumb.config");
    writeFileSync(configPath, [
      'REPO_URL="https://example.test/repo.git"',
      'CHECKS_CMD="echo ok"',
      `AGENT_WORKDIR="${path.join(root, "agent")}"`,
      'AGENT_CMD="true"',
      `LOG_FILE="${logFile}"`,
      "",
    ].join("\n"));
    process.env.PLUMB_CONFIG = configPath;

    assert.equal(await runCli(["run", "--context", "deploy=1111111"]), 0);
    assert.match(readFileSync(logFile, "utf8"), /plumb checks context=deploy=1111111/);
  } finally {
    if (oldConfig === undefined) delete process.env.PLUMB_CONFIG;
    else process.env.PLUMB_CONFIG = oldConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
