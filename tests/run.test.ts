import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run, type PlumbConfig, type RunAgentInput } from "../src/index.js";

function config(root: string, checksCommand: string): PlumbConfig {
  return {
    REPO_URL: "https://example.test/repo.git",
    CHECKS_CMD: checksCommand,
    AGENT_WORKDIR: path.join(root, "agent"),
    AGENT_CMD: "true",
    LOG_FILE: path.join(root, "logs", "checks.log"),
    PLUMB_STATE_DIR: path.join(root, "state"),
  };
}

test("run always returns zero and escalates only for a non-zero checks command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-run-"));
  try {
    const calls: RunAgentInput[] = [];
    const escalateOptions = { runAgent: (input: RunAgentInput) => calls.push(input) };
    const success = config(root, "echo ok; exit 0");
    assert.equal(run(success, { escalateOptions }), 0);
    assert.equal(calls.length, 0);
    assert.match(readFileSync(success.LOG_FILE, "utf8"), /plumb checks\nok\n/);

    const failure = config(root, "echo failed; exit 1");
    assert.equal(run(failure, { escalateOptions }), 0);
    assert.equal(calls.length, 1);
    assert.match(readFileSync(failure.LOG_FILE, "utf8"), /failed\n/);
    assert.match(calls[0]!.prompt, /An automated check or job named "checks" failed/);

    const brokenAgent = config(path.join(root, "broken-agent"), "exit 1");
    assert.equal(run(brokenAgent, { escalateOptions: { runAgent: () => { throw new Error("agent failed"); } } }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
