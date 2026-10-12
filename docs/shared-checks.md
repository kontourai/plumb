# Shared check observations

`@kontourai/plumb/checks` is a dependency-free observation API for producers such
as AI-DLC and Veritas. It does not run escalation, import an agent runtime, derive
trust status, authenticate reviewers, or advance a Flow gate.

Each producer keeps its check definitions and adapters. AI-DLC checks document
structure and traceability; Veritas evaluates repository standards and readiness.
The common contract records `pass`, `fail`, `not_verified`, or `not_applicable`,
findings, a SHA-256 subject basis, and the producer-observed file references.

```js
import { observeCheck, summarizeChecks } from '@kontourai/plumb/checks';

const result = await observeCheck({
  id: 'requirements-sections',
  basis: { kind: 'artifact-set', id: 'requirements', digest: observedSetDigest },
  evidence: observedFileDigests,
  run: () => checkActualRequirements(),
  verifyCurrent: (basis, evidence) => recheckActualFiles(basis, evidence),
});
const status = summarizeChecks([result], {
  basis: result.basis,
  requiredIds: ['requirements-sections'],
});
```

The producer obtains the subject digest and references from actual inputs before
execution and rechecks currency afterwards. These hashes identify bytes; they do
not establish who observed them. Scope the basis honestly: a check-definition
digest is not a repository revision. Authenticate imported observations at the
consumer boundary before using them as authority.

Missing output, malformed findings, adapter errors, and uncertain currency yield
`not_verified`. A passing output with findings becomes `fail`. A known failure
stays failed when its basis becomes stale. The input identity and references are
copied before the adapter runs, and returned observations are frozen.

Inapplicability requires explicit producer permission in both `observeCheck`
(`allowNotApplicable`) and `summarizeChecks` (`allowNotApplicableIds`). Aggregation
requires a nonempty list of expected checks, each present exactly once and bound
to the expected basis. Failure takes precedence over unavailable evidence.

Command adapters still own process custody, timeout, cancellation, output bounds,
exit-code interpretation and receipts. Domain adapters still own what their
findings mean. Surface derives trust from the producer's evidence; Flow applies
gate policy. `plumb run` retains its existing scheduled-job exit and escalation
behavior; callers must not treat its zero exit as a passing check observation.
