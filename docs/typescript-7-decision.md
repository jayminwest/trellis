# TypeScript 7 compiler-API decision (trellis-ea21)

Recorded 2026-09-25 against `typescript@7.0.2`. Governs dependabot PR
[jayminwest/trellis#10](https://github.com/jayminwest/trellis/pull/10)
(6.0.3 → 7.0.2).

## Evidence

trellis's shared parse layer and resolver call the in-process compiler API:
`ts.createSourceFile`, `node.getChildren`, `ts.SyntaxKind`,
`ts.resolveModuleName`, `ts.readConfigFile` and
`ts.parseJsonConfigFileContent` (`src/syntax/`, `src/metrics/`).

`typescript@7.0.2` (the native Go compiler) ships none of that:

- the package root exports only `./lib/version.cjs` — `createSourceFile` is
  `undefined` on a direct probe;
- the JavaScript surface is `typescript/unstable/*`: AST node types and
  factories (`unstable/ast`), plus sync/async **API clients** that talk to the
  native `tsgo` binary over a channel to parse, resolve and check;
- the native binary comes from a per-platform optional dependency
  (`@typescript/typescript-<os>-<arch>`).

## Decision

**Keep the runtime `typescript` dependency pinned at 6.0.3.** Do not merge
PR 10.

Adopting TypeScript 7 today would mean:

1. every native audit launching a child process — native audits currently
   create no scratch and launch nothing (SPEC §1, §16; pinned by
   `src/audit/providers.test.ts`);
2. depending on an API its authors label `unstable`;
3. per-platform binaries for a package whose invariant is "runs anywhere Bun
   runs, offline";
4. re-validating every native metric (token streams, CC, identities, module
   resolution) under a new analyzer version and the fixed corpus.

None of that is justified while 6.0.3 parses every TS/TSX construct the corpus
exercises. `.github/dependabot.yml` ignores `typescript` major 7 so the bump is
not re-proposed.

## Revisit when

- TypeScript 7 exposes a stable **in-process** parse/resolve API (no child
  process), or TypeScript 6.x stops parsing syntax real workspaces use.

A migration then needs its own versioned change: analyzer-version bump,
parity tests over the shared parse layer, and `scripts/validate-corpus.ts`
evidence showing unchanged (or explained) native metrics.
