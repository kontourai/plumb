import { loadConfig } from "./config.js";
import { escalate } from "./escalate.js";
import { run } from "./run.js";

const usage = `Usage:
  plumb run
  plumb escalate <context-name> <log-file>`;

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "run" && args.length === 0) return run(loadConfig());
    if (command === "escalate" && args.length === 2) {
      escalate(args[0]!, args[1]!, loadConfig());
      return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`plumb: ${message}\n`);
    return 1;
  }
  const informational = command === undefined || command === "--help" || command === "-h" || command === "--version";
  (informational ? process.stdout : process.stderr).write(`${usage}\n`);
  return informational ? 0 : 1;
}
