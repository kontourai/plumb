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
