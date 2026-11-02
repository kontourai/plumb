import { loadConfig } from "./config.js";
import { confirmFinding } from "./confirm.js";
import { escalate } from "./escalate.js";
import { run } from "./run.js";

const usage = `Usage:
  plumb run [--context <key>=<value>]
  plumb escalate <context-name> <log-file>
  plumb confirm <context-name> <finding-file> <repro-command>`;

const confirmExitCodes = { reproduced: 0, "not-reproduced": 2, inconclusive: 3 } as const;

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "run" && args.length === 0) return run(loadConfig());
    if (command === "run" && args.length === 2 && args[0] === "--context") {
      return run(loadConfig(), { context: args[1] });
    }
    if (command === "escalate" && args.length === 2) {
      escalate(args[0]!, args[1]!, loadConfig());
      return 0;
    }
    if (command === "confirm" && args.length === 3) {
      const result = confirmFinding(args[0]!, args[1]!, args[2]!, loadConfig());
      const detail = result.reason ?? `repro exit ${result.status}`;
      process.stdout.write(`plumb: ${args[0]} ${result.outcome} (${detail})\n`);
      return confirmExitCodes[result.outcome];
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
