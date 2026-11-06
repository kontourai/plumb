# Contributing to plumb

## Develop

- Node.js 22 or newer, and the pnpm version pinned in `package.json`'s
  `packageManager` field.
- Install with `pnpm install --frozen-lockfile`.
- `npm run verify` is the full local check: typecheck, build, the test suite,
  and `npm pack --dry-run`. CI runs it on Node 22 and 24.
- Read [`.veritas/GOVERNANCE.md`](.veritas/GOVERNANCE.md) before changing
  protected files.

## Docs

- Docs are published with Corpus to <https://kontourai.github.io/plumb/>.
  `corpus.json` lists the published docs and MCP topics, and
  `npm run docs:check` is the gate. When you change code that a document
  `covers`, update that document.

## Source-qualified documentation review

The Corpus gate selects the canonical documents mapped in `corpus.json` when
implementation inputs change. Review those claims against the actual callers.
Update inaccurate prose in the same PR. If it remains accurate, record a new
local input/output byte review with a concrete explanation and limits in
`corpus-content.json`, following the [shared review contract](https://github.com/kontourai/corpus/blob/b127e35a818b532369843731b3c64792baade83e/docs/related-content.md#review-an-unchanged-covering-document).
`npm run docs:check -- --base origin/main` uses that same reviewed Corpus source.
Do not add filler text or refresh hashes without inspecting the change. A
passing check does not certify semantic correctness, runtime or publication.
