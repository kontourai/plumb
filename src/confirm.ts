import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlumbConfig } from "./config.js";
import { escalate, nonNegativeInteger, type EscalateOptions, type EscalateResult } from "./escalate.js";

export type FindingOutcome = "reproduced" | "not-reproduced" | "inconclusive";

export interface ConfirmFindingOptions {
  escalateOptions?: EscalateOptions;
}

export interface ConfirmFindingResult {
  outcome: FindingOutcome;
  /** The repro command's exit status, or null when it did not exit normally. */
  status: number | null;
  /** The verdict the repro wrote to PLUMB_VERDICT_FILE, if any. */
  verdict?: string;
  /** Why the result is inconclusive; absent otherwise. */
  reason?: string;
  /** Present only when the finding was reproduced. */
  escalation?: EscalateResult;
}

// Field budgets keep a whole record under the escalation's 4000-byte evidence
// tail, so the agent always sees the finding next to the repro output.
const contextBytes = 200;
const commandBytes = 300;
const findingBytes = 1_500;
const outputBytes = 1_500;
const defaultTimeoutSeconds = 900;
// Extra time for the supervisor to report after it kills a timed-out repro.
const supervisorGraceMs = 10_000;

/**
 * Runs the repro in its own process group so a deadline kills every process it
 * started, not just its shell, and so processes left behind when it exits are
 * cleaned up too. Writes { code, signal, timedOut, error } to the result path.
 */
const supervisorSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [resultPath, timeoutMs] = process.argv.slice(1);
let timedOut = false;
let done = false;
const finish = (result) => {
  if (done) return;
  done = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  writeFileSync(resultPath, JSON.stringify({ ...result, timedOut }));
  process.exit(0);
};
const child = spawn("bash", ["-c", 'set -o pipefail; eval "$PLUMB_REPRO_CMD"'], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
child.on("error", (error) => finish({ error: String(error && error.message || error) }));
child.on("exit", (code, signal) => finish({ code, signal }));
const ms = Number(timeoutMs);
if (ms > 0) setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, ms).unref();
`;

export function findingsLogPath(logFile: string): string {
  return `${logFile.replace(/\.log$/, "")}-findings.log`;
}

function head(text: string, bytes: number, label: string): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= bytes ? text : `${buffer.subarray(0, bytes).toString("utf8")}\n[${label} truncated]`;
}

function tail(buffer: Buffer, bytes: number): string {
  if (buffer.length <= bytes) return buffer.toString("utf8");
  return `[output truncated]\n${buffer.subarray(buffer.length - bytes).toString("utf8")}`;
}

function readOrEmpty(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

interface SupervisorResult {
  code?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
}

/**
 * Escalates a finding only once its repro shows the defect.
 *
 * A finding is a claim, and an exit status alone cannot tell a failed
 * assertion from a crashed harness. So the repro must also say what it
 * observed, by writing `reproduced` or `not-reproduced` to the file named by
 * PLUMB_VERDICT_FILE. `reproduced` needs that verdict and a non-zero exit;
 * `not-reproduced` needs that verdict and exit 0. Everything else (no verdict,
 * a verdict that disagrees with the exit, a signal, a timeout, a start
 * failure) is inconclusive and never escalates.
 */
export function confirmFinding(
  context: string,
  findingPath: string,
  reproCommand: string,
  config: PlumbConfig,
  options: ConfirmFindingOptions = {},
): ConfirmFindingResult {
  if (!context || !findingPath || !reproCommand) {
    throw new Error("usage: plumb confirm <context-name> <finding-file> <repro-command>");
  }
  const finding = readFileSync(findingPath, "utf8").trim();
  if (!finding) throw new Error(`finding file is empty: ${findingPath}`);
  const timeoutSeconds = nonNegativeInteger(config.PLUMB_REPRO_TIMEOUT_SECS, defaultTimeoutSeconds, "PLUMB_REPRO_TIMEOUT_SECS");
  // Validate the guard settings before running anything, as plumb escalate does.
  nonNegativeInteger(config.PLUMB_ESCALATE_COOLDOWN_SECS, 0, "PLUMB_ESCALATE_COOLDOWN_SECS");
  nonNegativeInteger(config.PLUMB_ESCALATE_DAILY_CAP, 0, "PLUMB_ESCALATE_DAILY_CAP");

  const findingsLog = findingsLogPath(config.LOG_FILE);
  mkdirSync(path.dirname(findingsLog), { recursive: true });
  const startedAt = (options.escalateOptions?.now?.() ?? new Date()).toISOString();
  const runDirectory = mkdtempSync(path.join(os.tmpdir(), "plumb-confirm-"));
  try {
    const outputPath = path.join(runDirectory, "output.log");
    const resultPath = path.join(runDirectory, "result.json");
    const verdictPath = path.join(runDirectory, "verdict");
    // One descriptor for stdout and stderr keeps their order.
    const outputDescriptor = openSync(outputPath, "w");
    let supervisor;
    try {
      supervisor = spawnSync(process.execPath, ["-e", supervisorSource, resultPath, String(timeoutSeconds * 1000)], {
        env: { ...process.env, ...config.environment, PLUMB_REPRO_CMD: reproCommand, PLUMB_VERDICT_FILE: verdictPath },
        stdio: ["ignore", outputDescriptor, outputDescriptor],
        killSignal: "SIGKILL",
        timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 + supervisorGraceMs : undefined,
      });
    } finally {
      closeSync(outputDescriptor);
    }
    const output = readOrEmpty(outputPath);
    const verdictText = readOrEmpty(verdictPath).toString("utf8").trim();
    const verdict = verdictText || undefined;

    let repro: SupervisorResult | undefined;
    try {
      repro = JSON.parse(readFileSync(resultPath, "utf8")) as SupervisorResult;
    } catch {
      repro = undefined;
    }

    let result: ConfirmFindingResult;
    if (!repro) {
      const why = supervisor.error ? supervisor.error.message : `supervisor exited ${supervisor.status ?? supervisor.signal}`;
      result = { outcome: "inconclusive", status: null, verdict, reason: `repro supervisor failed: ${why}` };
    } else if (repro.error) {
      result = { outcome: "inconclusive", status: null, verdict, reason: `repro could not run: ${repro.error}` };
    } else if (repro.timedOut) {
      result = { outcome: "inconclusive", status: null, verdict, reason: `repro timed out after ${timeoutSeconds}s` };
    } else if (repro.code === null || repro.code === undefined) {
      result = { outcome: "inconclusive", status: null, verdict, reason: `repro was killed by ${repro.signal ?? "a signal"}` };
    } else if (verdict === "reproduced" && repro.code !== 0) {
      result = { outcome: "reproduced", status: repro.code, verdict };
    } else if (verdict === "not-reproduced" && repro.code === 0) {
      result = { outcome: "not-reproduced", status: 0, verdict };
    } else {
      result = {
        outcome: "inconclusive",
        status: repro.code,
        verdict,
        reason: verdict === undefined
          ? `repro exited ${repro.code} without writing a verdict to PLUMB_VERDICT_FILE`
          : `repro verdict ${JSON.stringify(head(verdict, 40, "verdict"))} does not match exit ${repro.code}`,
      };
    }

    const outcomeLine = result.reason
      ? `OUTCOME ${result.outcome} (${result.reason})`
      : `OUTCOME ${result.outcome} (verdict ${result.verdict}, exit ${result.status})`;
    const record = [
      `=== ${startedAt} plumb confirm ${head(context, contextBytes, "context")}`,
      `REPRO: ${head(reproCommand, commandBytes, "command")}`,
      "REPRO OUTPUT:",
      tail(output, outputBytes),
      "FINDING:",
      head(finding, findingBytes, "finding"),
      outcomeLine,
      "",
    ].join("\n");
    appendFileSync(findingsLog, record);
    if (result.outcome !== "reproduced") return result;

    // Escalate from this run's own record, not the shared log, so a concurrent
    // confirmation cannot swap in its evidence.
    const evidencePath = path.join(runDirectory, "evidence.log");
    writeFileSync(evidencePath, record);
    result.escalation = escalate(context, evidencePath, config, {
      ...options.escalateOptions,
      runContext:
        options.escalateOptions?.runContext ??
        `an exploratory finding was confirmed because its repro reported "reproduced" and exited ${result.status}; the evidence holds the finding and the repro output`,
    });
    return result;
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
}
