import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/index.js";

test("loadConfig sources bash syntax, expands HOME, and retains child environment", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-config-"));
  try {
    const configPath = path.join(root, "plumb.config");
    writeFileSync(configPath, [
      'REPO_URL="https://example.test/repo.git"',
      'CHECKS_CMD="echo $EXTRA_SETTING"',
      'AGENT_WORKDIR="$HOME/agent-work/example"',
      'AGENT_CMD="true"',
      'LOG_FILE="$HOME/logs/checks.log"',
      'EXTRA_SETTING="available-to-checks" # arbitrary sourced variables survive',
      "",
    ].join("\n"));
    const config = loadConfig(configPath);
    assert.equal(config.AGENT_WORKDIR, path.join(os.homedir(), "agent-work/example"));
    assert.equal(config.environment?.EXTRA_SETTING, "available-to-checks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
