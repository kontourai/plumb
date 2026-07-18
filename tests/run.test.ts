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

test("deploy context tags history, records the deploy, enriches escalation, and re-arms cooldown", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-run-deploy-"));
  try {
    const calls: RunAgentInput[] = [];
    const escalateOptions = { runAgent: (input: RunAgentInput) => calls.push(input) };
    const value = config(root, "echo failed; exit 1");
    const firstShaInput = "ABCDEF1ABCDEF1ABCDEF1ABCDEF1ABCDEF1ABC12";
    const firstSha = firstShaInput.toLowerCase();
    const secondSha = "2222222222222222222222222222222222222222";

    assert.equal(run(value, { context: `deploy=${firstShaInput}`, escalateOptions }), 0);
    assert.match(readFileSync(value.LOG_FILE, "utf8"), new RegExp(`plumb checks context=deploy=${firstSha}`));
    assert.equal(readFileSync(path.join(value.PLUMB_STATE_DIR!, "deploy-sha"), "utf8"), `${firstSha}\n`);
    assert.match(calls[0]!.prompt, new RegExp(`This failure began immediately after deploy ${firstSha}`));
    assert.match(calls[0]!.prompt, /no earlier deploy recorded/);

    assert.equal(run(value, { context: `deploy=${firstSha}`, escalateOptions }), 0);
    assert.equal(calls.length, 1, "a case variant of the same deploy SHA remains inside its cooldown");

    assert.equal(run(value, { context: `deploy=${secondSha}`, escalateOptions }), 0);
    assert.equal(calls.length, 2, "a new deploy SHA bypasses the prior deploy's cooldown");
    assert.match(calls[1]!.prompt, new RegExp(`${firstSha}\\.\\.${secondSha}`));
    assert.equal(readFileSync(path.join(value.PLUMB_STATE_DIR!, "deploy-sha"), "utf8"), `${secondSha}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed deploy context degrades to the existing run behavior", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-run-context-"));
  try {
    const calls: RunAgentInput[] = [];
    const value = config(root, "exit 1");
    let warning = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warning += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(run(value, {
        context: "deploy=not-a-sha",
        escalateOptions: { runAgent: (input) => calls.push(input) },
      }), 0);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(warning, 'plumb: ignoring malformed context "deploy=not-a-sha"\n');
    assert.doesNotMatch(readFileSync(value.LOG_FILE, "utf8"), /context=/);
    assert.doesNotMatch(calls[0]!.prompt, /immediately after deploy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-deploy context is tagged and passed downstream without changing guard identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plumb-run-generic-context-"));
  try {
    const calls: RunAgentInput[] = [];
    const value = config(root, "exit 1");
    assert.equal(run(value, {
      context: "release=blue",
      escalateOptions: { runAgent: (input) => calls.push(input) },
    }), 0);
    assert.match(readFileSync(value.LOG_FILE, "utf8"), /context=release=blue/);
    assert.match(calls[0]!.prompt, /Run context: release=blue/);
    assert.ok(readFileSync(path.join(value.PLUMB_STATE_DIR!, "last-checks"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
