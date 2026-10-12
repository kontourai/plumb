import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCheck, summarizeChecks, type CheckObservation, type CheckOutput } from "../src/checks.js";
const basis = { kind: "artifact-set", id: "requirements", digest: "a".repeat(64) };
const evidence = [{ path: "requirements.md", sha256: "b".repeat(64) }];
const options = { id: "sections", basis, evidence, verifyCurrent: () => true };
const aggregate = { basis, requiredIds: ["sections"] };

test("the public checks subpath imports without the escalation runtime", async () => {
  const api = await import("@kontourai/plumb/checks");
  assert.equal(api.observeCheck, observeCheck);
  assert.deepEqual(Object.keys(api).sort(), ["observeCheck", "summarizeChecks"]);
});

test("a real artifact changed during an async check cannot produce a passing result", async () => {
  const root = mkdtempSync(join(tmpdir(), "plumb-check-basis-"));
  const file = join(root, "requirements.md");
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    writeFileSync(file, "approved requirement bytes");
    const observedDigest = hash();
    const result = await observeCheck({
      id: "sections", basis: { ...basis, digest: observedDigest },
      evidence: [{ path: "requirements.md", sha256: observedDigest }],
      run: async () => { await Promise.resolve(); writeFileSync(file, "different requirement bytes"); return { status: "pass", findings: [] }; },
      verifyCurrent: (subject, refs) => hash() === subject.digest && refs.every(ref => hash() === ref.sha256),
    });
    assert.equal(result.status, "not_verified");
    assert.equal(result.basis.digest, observedDigest);
  } finally { rmSync(root, { recursive: true }); }
});

test("only actual adapter output with a confirmed basis produces a passing observation", async () => {
  let calls = 0;
  const result = await observeCheck({ ...options, run: () => { calls++; return { status: "pass", findings: [] }; } });
  assert.equal(calls, 1);
  assert.equal(summarizeChecks([JSON.parse(JSON.stringify(result))], aggregate), "pass");
  assert.ok(Object.isFrozen(result.evidence_refs[0]));
});
test("missing, malformed, throwing and oversized outputs fail closed", async () => {
  for (const value of [undefined, {}, { status: "passed", findings: [] }, { status: "pass" }, { status: "pass", findings: [""] }, { status: "pass", findings: ["x".repeat(4097)] }]) {
    assert.equal((await observeCheck({ ...options, run: () => value })).status, "not_verified");
  }
  assert.equal((await observeCheck({ ...options, run: () => { throw new Error("tool missing"); } })).status, "not_verified");
});
test("a passing result cannot hide findings, or waive its applicability", async () => {
  assert.equal((await observeCheck({ ...options, run: () => ({ status: "pass", findings: ["missing section"] }) })).status, "fail");
  const run = (): CheckOutput => ({ status: "not_applicable", findings: [] });
  assert.equal((await observeCheck({ ...options, run })).status, "not_verified");
  const result = await observeCheck({ ...options, run, allowNotApplicable: true });
  assert.equal(summarizeChecks([result], aggregate), "not_verified");
  assert.equal(summarizeChecks([result], { ...aggregate, allowNotApplicableIds: ["sections"] }), "pass");
});
test("changed or uncertain basis blocks pass and preserves a known failure", async () => {
  for (const verifyCurrent of [() => false, () => { throw new Error("read refused"); }, () => undefined as unknown as boolean]) {
    const passed = await observeCheck({ ...options, verifyCurrent, run: () => ({ status: "pass", findings: [] }) });
    assert.equal(passed.status, "not_verified");
    const failed = await observeCheck({ ...options, verifyCurrent, run: () => ({ status: "fail", findings: ["defect"] }) });
    assert.equal(failed.status, "fail");
    assert.ok(failed.findings.includes("defect"));
  }
});
test("adapter mutation cannot replace identity, evidence, or applicability policy", async () => {
  const mutable = { ...options, basis: { ...basis }, evidence: structuredClone(evidence), allowNotApplicable: false, run: (): CheckOutput => ({ status: "pass", findings: [] }) };
  mutable.run = () => { mutable.basis.digest = "c".repeat(64); mutable.evidence[0].sha256 = "d".repeat(64); mutable.id = "replacement"; mutable.allowNotApplicable = true; return { status: "not_applicable", findings: [] }; };
  const result = await observeCheck(mutable);
  assert.equal(result.id, "sections");
  assert.deepEqual(result.basis, basis);
  assert.deepEqual(result.evidence_refs, evidence);
  assert.equal(result.status, "not_verified");
});
test("aggregation refuses missing, duplicate, stale and malformed required evidence", async () => {
  const good = await observeCheck({ ...options, run: () => ({ status: "pass", findings: [] }) });
  for (const observations of [[], [good, good], [{ ...good, basis: { ...basis, digest: "e".repeat(64) } }], [{ ...good, evidence_refs: undefined }], [{ ...good, findings: undefined }], [{ ...good, schema_version: "2.0" }]]) {
    assert.equal(summarizeChecks(observations as CheckObservation[], aggregate), "not_verified");
  }
  assert.equal(summarizeChecks([good], { ...aggregate, requiredIds: [] }), "not_verified");
  const fail = await observeCheck({ ...options, id: "tests", run: () => ({ status: "fail", findings: ["test failed"] }) });
  assert.equal(summarizeChecks([fail], { ...aggregate, requiredIds: ["tests", "missing"] }), "fail");
});
