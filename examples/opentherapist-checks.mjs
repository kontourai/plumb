import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApp = createRequire(path.join(repoRoot, "app/package.json"));
const { Pool } = requireFromApp("pg");
const clean = (value) => String(value).replace(/\s+/g, " ").trim();

export async function inspectAtlasArtifacts(root = repoRoot) {
  const dataRoot = path.join(root, "app/src/domain/atlas/data");
  const [countyUnder18, zctaCounty] = await Promise.all([
    readFile(path.join(dataRoot, "county-under18.json"), "utf8").then(JSON.parse),
    readFile(path.join(dataRoot, "zcta-county.json"), "utf8").then(JSON.parse),
  ]);
  const counties = Object.keys(countyUnder18).length;
  const zctas = Object.keys(zctaCounty).length;
  if (counties <= 3_000) throw new Error(`county coverage ${counties} (expected >3000)`);
  if (!zctas) throw new Error("ZCTA artifact is empty");
  return `${counties} counties, ${zctas} ZCTAs`;
}

export async function runChecks({ appUrl = process.env.APP_URL ?? "http://localhost:3000", databaseUrl = process.env.DATABASE_URL } = {}) {
  const results = [];
  const check = async (name, operation) => {
    try {
      results.push({ ok: true, name, detail: clean(await operation()) });
    } catch (error) {
      results.push({ ok: false, name, detail: clean(error instanceof Error ? error.message : error) });
    }
  };

  await check("app-health-build", async () => {
    // Expected SHA comes from the caller (EXPECTED_SHA env) when running in a
    // container without git; falls back to spawning git on the host.
    const expected = process.env.EXPECTED_SHA?.trim()
      || (await execFile("git", ["rev-parse", "origin/main"], { cwd: repoRoot })).stdout.trim();
    const response = await fetch(new URL("/api/health", appUrl), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    const health = await response.json();
    if (health.build !== expected) throw new Error(`build ${health.build ?? "missing"}, expected ${expected}`);
    return `HTTP 200, build ${expected}`;
  });

  await check("atlas-artifacts", () => inspectAtlasArtifacts(repoRoot));
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 }) : null;
  const query = async (text) => {
    if (!pool) throw new Error("DATABASE_URL is required");
    return pool.query(text);
  };
  await check("db-reachable", async () => { await query("select 1"); return "query succeeded"; });
  await check("npi-freshness", async () => {
    const { rows } = await query("select count(*)::bigint as count, max(last_updated) as newest from npi_providers");
    const count = Number(rows[0]?.count ?? 0);
    const newest = rows[0]?.newest ? new Date(rows[0].newest) : null;
    if (count <= 600_000) throw new Error(`provider count ${count} (expected >600000)`);
    if (!newest || Number.isNaN(newest.getTime())) throw new Error("newest last_updated is missing");
    const ageDays = (Date.now() - newest.getTime()) / 86_400_000;
    if (ageDays > 45) throw new Error(`newest last_updated ${newest.toISOString()} is ${ageDays.toFixed(1)} days old`);
    return `${count} providers, newest ${newest.toISOString()} (${ageDays.toFixed(1)} days old)`;
  });

  if (pool) await pool.end();
  for (const result of results) console.log(`${result.ok ? "OK" : "FAIL"} ${result.name} ${result.detail}`);
  return results.every((result) => result.ok);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runChecks() ? 0 : 1;
