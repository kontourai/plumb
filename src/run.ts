import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { escalate, type EscalateOptions } from "./escalate.js";
import type { PlumbConfig } from "./config.js";

export interface RunOptions {
  context?: string;
  escalateOptions?: EscalateOptions;
}

interface RunContext {
  key: string;
  value: string;
}

function parseContext(value: string | undefined): RunContext | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf("=");
  if (separator < 1) return undefined;
  const key = value.slice(0, separator);
  const contextValue = value.slice(separator + 1);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || !contextValue || /[\r\n]/.test(contextValue)) return undefined;
  if (key === "deploy" && !/^[0-9a-fA-F]{7,64}$/.test(contextValue)) return undefined;
  return { key, value: key === "deploy" ? contextValue.toLowerCase() : contextValue };
}

export function run(config: PlumbConfig, options: RunOptions = {}): number {
  const context = parseContext(options.context);
  if (options.context !== undefined && context === undefined) {
    process.stderr.write(`plumb: ignoring malformed context ${JSON.stringify(options.context)}\n`);
  }
  const stateDirectory = config.PLUMB_STATE_DIR ?? path.join(path.dirname(config.LOG_FILE), "state");
  let previousDeploySha: string | undefined;
  if (context?.key === "deploy") {
    try {
      mkdirSync(stateDirectory, { recursive: true });
      const deployStatePath = path.join(stateDirectory, "deploy-sha");
      try {
        const stored = readFileSync(deployStatePath, "utf8").trim();
        if (/^[0-9a-fA-F]{7,64}$/.test(stored) && stored !== context.value) previousDeploySha = stored;
      } catch {
        // A missing or unreadable prior deploy must not prevent checks or escalation.
      }
      writeFileSync(deployStatePath, `${context.value}\n`);
    } catch {
      // Context enrichment is best effort; preserve the existing check runner.
    }
  }
  mkdirSync(path.dirname(config.LOG_FILE), { recursive: true });
  const descriptor = openSync(config.LOG_FILE, "a");
  let status: number;
  try {
    // date -Is used the machine's local timezone; ISO timestamps here are UTC Z.
    const contextTag = context ? ` context=${context.key}=${context.value}` : "";
    writeSync(descriptor, `=== ${new Date().toISOString()} plumb checks${contextTag}\n`);
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
      const deployContext = context?.key === "deploy"
        ? { sha: context.value, previousSha: previousDeploySha }
        : undefined;
      escalate("checks", config.LOG_FILE, config, {
        ...options.escalateOptions,
        deployContext,
        guardSignature: deployContext ? `deploy:${deployContext.sha}` : options.escalateOptions?.guardSignature,
        runContext: context ? `${context.key}=${context.value}` : options.escalateOptions?.runContext,
      });
    } catch {
      // Escalation is a best-effort side effect; the run command always exits 0.
    }
  }
  return 0;
}
