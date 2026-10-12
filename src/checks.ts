/** Check observations, independent of escalation, workflow policy and trust derivation. */
export type CheckStatus = "pass" | "fail" | "not_verified" | "not_applicable";
export interface CheckBasis { kind: string; id: string; digest: string }
export interface CheckEvidence { path: string; sha256: string }
export interface CheckOutput { status: CheckStatus; findings: readonly string[] }
export interface CheckObservation extends CheckOutput {
  schema_version: "1.0";
  id: string;
  basis: CheckBasis;
  evidence_refs: readonly CheckEvidence[];
}
export interface ObserveCheckOptions {
  id: string;
  basis: CheckBasis;
  evidence: readonly CheckEvidence[];
  /** A producer-owned adapter that executes or reads the actual check. */
  run: () => Promise<unknown> | unknown;
  /** Re-read the producer's basis after execution. Missing or uncertain currency cannot pass. */
  verifyCurrent: (basis: Readonly<CheckBasis>, evidence: readonly CheckEvidence[]) => Promise<boolean> | boolean;
  /** A producer must explicitly permit inapplicability; the check cannot waive itself. */
  allowNotApplicable?: boolean;
}
const LIMIT = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const statuses = new Set<CheckStatus>(["pass", "fail", "not_verified", "not_applicable"]);
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LIMIT && !value.includes("\0");
}
function basisValid(value: CheckBasis): boolean {
  return Boolean(value && text(value.kind) && text(value.id) && typeof value.digest === "string" && SHA256.test(value.digest));
}
function evidenceValid(value: unknown): value is readonly CheckEvidence[] {
  return Array.isArray(value) && value.length <= LIMIT && value.every((ref: CheckEvidence) => ref && text(ref.path) && typeof ref.sha256 === "string" && SHA256.test(ref.sha256));
}
function output(value: unknown): CheckOutput {
  if (!value || typeof value !== "object") throw new Error("Missing check output");
  const candidate = value as CheckOutput;
  if (!statuses.has(candidate.status) || !Array.isArray(candidate.findings) || candidate.findings.length > LIMIT || !candidate.findings.every(text)) {
    throw new Error("Malformed check output");
  }
  if (candidate.findings.reduce((bytes, finding) => bytes + Buffer.byteLength(finding), 0) > 1024 * 1024) throw new Error("Check findings exceed byte limit");
  return { status: candidate.status === "pass" && candidate.findings.length ? "fail" : candidate.status, findings: [...candidate.findings] };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Observe one check. This records producer observations; it grants no review or gate authority. */
export async function observeCheck(options: ObserveCheckOptions): Promise<CheckObservation> {
  if (!text(options.id) || !basisValid(options.basis) || !evidenceValid(options.evidence)) {
    throw new Error("Malformed check identity or basis");
  }
  const id = options.id;
  const basis = freeze(structuredClone(options.basis));
  const evidence = freeze(structuredClone(options.evidence));
  const allowNotApplicable = options.allowNotApplicable === true;
  const run = options.run;
  const verifyCurrent = options.verifyCurrent;
  let result: CheckOutput;
  try {
    result = output(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Check adapter failed";
    result = { status: "not_verified", findings: [message.slice(0, LIMIT) || "Check adapter failed"] };
  }
  if (result.status === "not_applicable" && !allowNotApplicable) result = { status: "not_verified", findings: [...result.findings, "Producer did not authorize inapplicability"] };
  let current = false;
  try { current = await verifyCurrent(basis, evidence) === true; } catch { /* Currency is unknown. */ }
  if (!current) result = { status: result.status === "fail" ? "fail" : "not_verified", findings: [...result.findings, "Check basis is stale or could not be confirmed"] };
  return freeze({ schema_version: "1.0", id, basis, evidence_refs: evidence, ...result });
}

/** Required checks must be present exactly once and bound to the expected subject. */
export function summarizeChecks(observations: readonly CheckObservation[], options: { requiredIds: readonly string[]; basis: CheckBasis; allowNotApplicableIds?: readonly string[] }): CheckStatus {
  if (!basisValid(options.basis) || !Array.isArray(options.requiredIds) || !options.requiredIds.length || options.requiredIds.length > LIMIT || !options.requiredIds.every(text) || new Set(options.requiredIds).size !== options.requiredIds.length || !Array.isArray(observations) || observations.length > LIMIT || (options.allowNotApplicableIds !== undefined && (!Array.isArray(options.allowNotApplicableIds) || !options.allowNotApplicableIds.every(text)))) return "not_verified";
  const required: CheckStatus[] = [];
  for (const id of options.requiredIds) {
    const matches = observations.filter(result => result?.id === id);
    if (matches.length !== 1) { required.push("not_verified"); continue; }
    const result = matches[0];
    if (result.schema_version !== "1.0" || !basisValid(result.basis) || result.basis.kind !== options.basis.kind || result.basis.id !== options.basis.id || result.basis.digest !== options.basis.digest || !evidenceValid(result.evidence_refs)) { required.push("not_verified"); continue; }
    try {
      const status = output(result).status;
      required.push(status === "not_applicable" && !options.allowNotApplicableIds?.includes(id) ? "not_verified" : status);
    } catch { required.push("not_verified"); }
  }
  return required.includes("fail") ? "fail" : required.includes("not_verified") ? "not_verified" : "pass";
}
