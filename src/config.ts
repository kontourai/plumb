import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PlumbConfig {
  REPO_URL: string;
  CHECKS_CMD: string;
  AGENT_WORKDIR: string;
  AGENT_CMD: string;
  LOG_FILE: string;
  CONTEXT_DOCS?: string;
  PLUMB_STATE_DIR?: string;
  PLUMB_ESCALATE_COOLDOWN_SECS?: string;
  PLUMB_ESCALATE_DAILY_CAP?: string;
  /** All variables exported while sourcing the config, for child commands. */
  environment?: Readonly<Record<string, string>>;
}

const requiredKeys = ["REPO_URL", "CHECKS_CMD", "AGENT_WORKDIR", "AGENT_CMD", "LOG_FILE"] as const;
const optionalKeys = [
  "CONTEXT_DOCS",
  "PLUMB_STATE_DIR",
  "PLUMB_ESCALATE_COOLDOWN_SECS",
  "PLUMB_ESCALATE_DAILY_CAP",
] as const;

function defaultConfigPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plumb.config");
}

export function loadConfig(configPath = process.env.PLUMB_CONFIG ?? defaultConfigPath()): PlumbConfig {
  // Bash remains the parser so existing sourced configs retain expansion,
  // quoting, comments, and command-substitution behavior unchanged.
  const output = execFileSync(
    "bash",
    ["-c", 'set -a; source "$1"; env -0', "_", configPath],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const environment: Record<string, string> = {};
  for (const entry of output.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator >= 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  const config = { environment } as PlumbConfig;
  for (const key of requiredKeys) {
    const value = environment[key];
    if (value === undefined || value === "") throw new Error(`Missing required config key: ${key}`);
    config[key] = value;
  }
  for (const key of optionalKeys) {
    const value = environment[key];
    if (value !== undefined) config[key] = value;
  }
  return config;
}
