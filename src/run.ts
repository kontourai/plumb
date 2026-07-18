import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { escalate, type EscalateOptions } from "./escalate.js";
import type { PlumbConfig } from "./config.js";

export interface RunOptions {
  escalateOptions?: EscalateOptions;
}

export function run(config: PlumbConfig, options: RunOptions = {}): number {
  mkdirSync(path.dirname(config.LOG_FILE), { recursive: true });
  const descriptor = openSync(config.LOG_FILE, "a");
  let status: number;
  try {
    // date -Is used the machine's local timezone; ISO timestamps here are UTC Z.
    writeSync(descriptor, `=== ${new Date().toISOString()} plumb checks\n`);
    const result = spawnSync("bash", ["-c", 'set -uo pipefail; eval "$CHECKS_CMD"'], {
      env: { ...process.env, ...config.environment, CHECKS_CMD: config.CHECKS_CMD },
      stdio: ["inherit", descriptor, descriptor],
    });
    status = result.status ?? 1;
  } finally {
    closeSync(descriptor);
  }
  if (status !== 0) {
    try {
      escalate("checks", config.LOG_FILE, config, options.escalateOptions);
    } catch {
      // Escalation is a best-effort side effect; the run command always exits 0.
    }
  }
  return 0;
}
