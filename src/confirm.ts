import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
  /** Why the result is inconclusive; absent otherwise. */
  reason?: string;
  /** Present only when the finding was reproduced. */
  escalation?: EscalateResult;
}

const findingBytes = 1_500;
const outputBytes = 1_500;
const defaultTimeoutSeconds = 900;

export function findingsLogPath(logFile: string): string {
  return `${logFile.replace(/\.log$/, "")}-findings.log`;
}

function head(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= bytes ? text : `${buffer.subarray(0, bytes).toString("utf8")}\n[finding truncated]`;
}

function tail(buffer: Buffer, bytes: number): string {
  if (buffer.length <= bytes) return buffer.toString("utf8");
  return `[output truncated]\n${buffer.subarray(buffer.length - bytes).toString("utf8")}`;
}

/**
 * Escalates a finding only once its repro command fails.
 *
 * A finding from exploration is a claim, not evidence. The repro command must
 * exit non-zero to show the defect; exit 0 means the claim did not reproduce.
 * A repro that could not run (spawn error, signal, timeout, or the shell's 126
 * and 127 for an unrunnable or missing command) is inconclusive, so a broken
 * harness never becomes a confirmed defect.
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

  const findingsLog = findingsLogPath(config.LOG_FILE);
  mkdirSync(path.dirname(findingsLog), { recursive: true });
  const startedAt = (options.escalateOptions?.now?.() ?? new Date()).toISOString();

  const repro = spawnSync("bash", ["-c", 'set -uo pipefail; eval "$PLUMB_REPRO_CMD"'], {
    env: { ...process.env, ...config.environment, PLUMB_REPRO_CMD: reproCommand },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
  });
  const output = Buffer.concat([repro.stdout ?? Buffer.alloc(0), repro.stderr ?? Buffer.alloc(0)]);

  let result: ConfirmFindingResult;
  if (repro.error) {
    const timedOut = (repro.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    result = {
      outcome: "inconclusive",
      status: null,
      reason: timedOut ? `repro timed out after ${timeoutSeconds}s` : `repro could not run: ${repro.error.message}`,
    };
  } else if (repro.status === null) {
    result = { outcome: "inconclusive", status: null, reason: `repro was killed by ${repro.signal ?? "a signal"}` };
  } else if (repro.status === 126 || repro.status === 127) {
    result = {
      outcome: "inconclusive",
      status: repro.status,
      reason: `repro exited ${repro.status}: the command could not be found or run`,
    };
  } else if (repro.status === 0) {
    result = { outcome: "not-reproduced", status: 0 };
  } else {
    result = { outcome: "reproduced", status: repro.status };
  }

  // One self-contained record, kept small enough that the escalation's
  // 4000-byte evidence tail starts inside it.
  const outcomeLine = result.reason
    ? `OUTCOME ${result.outcome} (${result.reason})`
    : `OUTCOME ${result.outcome} (exit ${result.status})`;
  appendFileSync(
    findingsLog,
    [
      `=== ${startedAt} plumb confirm ${context}`,
      "FINDING:",
      head(finding, findingBytes),
      `REPRO: ${reproCommand}`,
      "REPRO OUTPUT:",
      tail(output, outputBytes),
      outcomeLine,
      "",
    ].join("\n"),
  );

  if (result.outcome !== "reproduced") return result;
  result.escalation = escalate(context, findingsLog, config, {
    ...options.escalateOptions,
    runContext:
      options.escalateOptions?.runContext ??
      `an exploratory finding was confirmed because its repro command failed with exit ${result.status}; the evidence holds the finding and the repro output`,
  });
  return result;
}
