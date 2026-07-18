import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { PlumbConfig } from "./config.js";

export interface EscalateResult {
  escalated: boolean;
  reason?: string;
}

export interface RunAgentInput {
  config: PlumbConfig;
  prompt: string;
  escalationLog: string;
}

export interface EscalateOptions {
  runAgent?: (input: RunAgentInput) => void;
  now?: () => Date;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function escalationLogPath(logFile: string): string {
  return `${logFile.replace(/\.log$/, "")}-escalations.log`;
}

function appendSuppression(logFile: string, timestamp: string, context: string, reason: string): EscalateResult {
  appendFileSync(logFile, `${timestamp} SUPPRESS ${context} (${reason})\n`);
  return { escalated: false, reason };
}

function acquireLock(lockPath: string, token: string, nowSeconds: number, staleAfterSeconds: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeSync(descriptor, token);
      } finally {
        closeSync(descriptor);
      }
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      // O_EXCL lockfiles do not auto-release after a hard kill like flock does.
      // Reclaim one older than the cooldown so a killed run cannot wedge forever.
      let ageSeconds: number;
      try {
        ageSeconds = nowSeconds - statSync(lockPath).mtimeMs / 1000;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (ageSeconds <= staleAfterSeconds) return false;
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function pruneCounters(stateDirectory: string, nowMs: number): void {
  for (const name of readdirSync(stateDirectory)) {
    if (!name.startsWith("count-")) continue;
    const file = path.join(stateDirectory, name);
    try {
      if (nowMs - statSync(file).mtimeMs > 3 * 86_400_000) unlinkSync(file);
    } catch {
      // Matches the original best-effort `find ... -delete || true` cleanup.
    }
  }
}

function tailEvidence(logPath: string): string {
  try {
    const contents = readFileSync(logPath);
    return contents.subarray(Math.max(0, contents.length - 4_000)).toString("utf8").replace(/\n+$/, "");
  } catch {
    return "log unavailable";
  }
}

function promptFor(context: string, evidence: string, contextDocs: string | undefined): string {
  return `You are the on-call maintenance agent for this deployment.

An automated check or job named "${context}" failed. Evidence (log tail):
---
${evidence}
---

Diagnose the root cause. Read ${contextDocs ?? "the repo docs"} first. You may inspect services, containers, and logs, and run READ-ONLY queries against databases.

STRICT GUARDRAILS:
- Never modify or delete production data; SELECT-only against any database.
- Never commit to main, never force-push, never touch secrets files.
- Confident code/config fix: branch auto/fix-<short-name>, commit, push the branch, open a PR (gh pr create) describing cause and fix. Do NOT merge.
- Uncertain or environmental cause (disk, network, upstream outage): file an issue titled "[auto] ${context} failing" with full diagnosis and recommendation — check for an existing open issue with that title first and comment instead of duplicating.
- End with a one-paragraph summary of what you did.`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function realRunAgent({ config, prompt, escalationLog }: RunAgentInput): void {
  if (!isDirectory(path.join(config.AGENT_WORKDIR, ".git"))) {
    mkdirSync(path.dirname(config.AGENT_WORKDIR), { recursive: true });
    spawnSync("git", ["clone", "-q", config.REPO_URL, config.AGENT_WORKDIR], { stdio: "inherit" });
  }
  const fetched = spawnSync("git", ["-C", config.AGENT_WORKDIR, "fetch", "-q", "origin"], { stdio: "inherit" });
  if (fetched.status === 0) {
    spawnSync("git", ["-C", config.AGENT_WORKDIR, "reset", "-q", "--hard", "origin/main"], { stdio: "inherit" });
  }

  const descriptor = openSync(escalationLog, "a");
  try {
    const agent = spawnSync(
      "bash",
      ["-lc", `cd ${shellQuote(config.AGENT_WORKDIR)} && ${config.AGENT_CMD} ${shellQuote(prompt)}`],
      { env: { ...process.env, ...config.environment }, stdio: ["inherit", descriptor, descriptor] },
    );
    if (agent.error) throw agent.error;
    if (agent.status !== 0) throw new Error(`Agent command exited with status ${agent.status ?? "unknown"}`);
  } finally {
    closeSync(descriptor);
  }
}

export function escalate(
  context: string,
  logPath: string,
  config: PlumbConfig,
  options: EscalateOptions = {},
): EscalateResult {
  if (!context || !logPath) throw new Error("usage: plumb escalate <name> <log-file>");
  const escalationLog = escalationLogPath(config.LOG_FILE);
  mkdirSync(path.dirname(escalationLog), { recursive: true });
  const stateDirectory = config.PLUMB_STATE_DIR ?? path.join(path.dirname(config.LOG_FILE), "state");
  mkdirSync(stateDirectory, { recursive: true });
  const cooldownSeconds = positiveInteger(config.PLUMB_ESCALATE_COOLDOWN_SECS, 21_600, "PLUMB_ESCALATE_COOLDOWN_SECS");
  const dailyCap = positiveInteger(config.PLUMB_ESCALATE_DAILY_CAP, 8, "PLUMB_ESCALATE_DAILY_CAP");
  const now = options.now?.() ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const slug = context.replace(/[^A-Za-z0-9]/g, "_");
  const lockPath = path.join(stateDirectory, `lock-${slug}`);
  const lockToken = `${process.pid}:${now.getTime()}:${Math.random()}`;

  if (!acquireLock(lockPath, lockToken, nowSeconds, cooldownSeconds)) {
    // The old scripts used date -Is in local time; the package intentionally
    // standardizes these timestamps on UTC ISO strings ending in Z.
    return appendSuppression(escalationLog, now.toISOString(), context, "already running");
  }

  try {
    const stampPath = path.join(stateDirectory, `last-${slug}`);
    if (existsSync(stampPath)) {
      const last = Number.parseInt(readFileSync(stampPath, "utf8"), 10) || 0;
      if (nowSeconds - last < cooldownSeconds) {
        return appendSuppression(escalationLog, now.toISOString(), context, `within ${cooldownSeconds}s cooldown`);
      }
    }

    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const countPath = path.join(stateDirectory, `count-${day}`);
    const count = existsSync(countPath) ? Number.parseInt(readFileSync(countPath, "utf8"), 10) || 0 : 0;
    if (count >= dailyCap) {
      return appendSuppression(escalationLog, now.toISOString(), context, `daily cap ${dailyCap} reached`);
    }

    writeFileSync(stampPath, `${nowSeconds}\n`);
    writeFileSync(countPath, `${count + 1}\n`);
    pruneCounters(stateDirectory, now.getTime());
    const prompt = promptFor(context, tailEvidence(logPath), config.CONTEXT_DOCS);
    (options.runAgent ?? realRunAgent)({ config, prompt, escalationLog });
    return { escalated: true };
  } finally {
    releaseLock(lockPath, lockToken);
  }
}
