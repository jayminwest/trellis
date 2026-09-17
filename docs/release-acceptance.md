# Deterministic pivot acceptance — pl-b2ea

Validated on 2026-09-17 for `trellis-253e`, with final integration in
`trellis-d03d`, backlog reconciliation in `trellis-b12d`, and public catalog
retirement in `trellis-a835`. This records local release readiness; no
publish, tag, remote push, or hosted service is part of this acceptance.

## Product contract and evidence

| Contract | Executable evidence |
|---|---|
| Offline default, no credentials/tools/Git/project dependencies, no target command or executable config evaluation, no writes | `src/audit/offline.test.ts`: real CLI/SDK audit and fleet in child processes with an empty executable path, a minimal environment, forbidden subprocess/fetch boundaries, and recursive before/after file-byte snapshots |
| Stable measurements over unchanged input; dirty files are analyzed | `src/audit/audit.test.ts`: equality without run metadata, dirty/non-Git changes, unsupported source and incomplete analysis |
| CLI/SDK audit, comparison and fleet policy parity | `src/client/index.test.ts`, `src/cli/exit-codes.test.ts`, `src/fleet/orchestrate.test.ts` |
| Artifact comparison without an audit; incompatible pairs fail closed | `src/compare/compare.test.ts`, `src/cli/compare.test.ts` |
| Opt-in history; append-only migration preserves separate readiness rows | `src/store/audit-store.test.ts`, `src/store/store.test.ts`, `src/cli/report.test.ts` |
| Standards/drift remain separate from score and fleet policy | `src/standards/drift.test.ts`, `src/fleet/assess.test.ts`, SDK drift parity |
| Public readiness catalog removed; retired investigation knobs reject rather than execute | `src/cli/main.test.ts`, `src/cli/audit.test.ts`, `src/client/index.test.ts`, `src/legacy.test.ts`, `src/fleet/targets.test.ts` |
| Score bounded, traceable and separate from safeguards | `src/scoring/sloppiness.test.ts`, `src/audit/audit.test.ts`, fixed corpus pairs |
| Package ships required analyzer assets and boots offline | `bun run smoke:package`: packed 0.2.0 CLI audits a fixture at index 0 |

The external-boundary regression is isolated to its child processes; it
stubs no filesystem, SQLite, parser, analyzer, policy or renderer. It blocks
Bun and Node subprocess APIs and `fetch`, including swallowed attempts. It
is not an OS network firewall; source review additionally confirms the
current audit core uses local parsing, file reads and arithmetic. The
runtime dependency set remains commander, js-yaml, TypeScript and
zod, with no model SDK, agent provider or live-capture machinery.

Legacy rubric/detector/report internals remain for historical compatibility
and regression fixtures. Public audits do not call them. The public SDK no
longer exports readiness catalog or assessment helpers; `trellis rubric`
only returns retirement guidance. `drift` and `standards` remain supported
canonical-config capabilities, independently of the structural audit.

## Validation environment and results

Base revision: `ba3cf82f5d2e7b88e70cdd53f86d174a0731cfa9`, with this final
acceptance change. Bun 1.3.14-canary.1, TypeScript 6.0.3, macOS arm64,
Apple M4 Pro, 24 GiB RAM. Analyzer 0.2.0, schema 1.0.0, scoring
0.1.0-provisional. Gates ran under the workspace-write sandbox without
network escalation or budget changes.

Required commands:

```bash
bun run lint
bun run typecheck
bun test
bun run check:all
bun run smoke:package
bun run scripts/validate-corpus.ts
bun run src/cli/main.ts audit . --json --quiet
```

All commands above exited 0: **1,387 tests across 121 files**, four
snapshots, and **9/9 quality gates**. The six focused package-smoke tests
also passed (`bun test ./scripts/smoke-package.test.ts`). No ratchet was
loosened. The self-audit stayed at **58/100, complete**, matching the
pre-change 58 rather than regressing; the earlier Linux calibration revision
scored 59 and is retained as historical evidence, not a timing baseline.

| entry | prod files | prod sloc | index | partial | median ms | peak MiB | budget |
|---|---|---|---|---|---|---|---|
| clean-small | 2 | 10 | 0 | false | 17 | 106 | ok |
| clone-base | 3 | 43 | 16 | false | 20 | 111 | ok |
| clone-removed | 3 | 28 | 0 | false | 19 | 110 | ok |
| branch-base | 3 | 17 | 0 | false | 18 | 106 | ok |
| branch-grown | 3 | 44 | 26 | false | 21 | 111 | ok |
| acyclic | 4 | 15 | 0 | false | 17 | 107 | ok |
| cyclic | 4 | 16 | 12 | false | 17 | 106 | ok |
| dilution-base | 4 | 80 | 42 | false | 26 | 114 | ok |
| dilution-grown | 6 | 175 | 42 | false | 27 | 118 | ok |
| test-separation | 2 | 10 | 0 | false | 23 | 114 | ok |
| incomplete-parse | 2 | 4 | 100 | true | 16 | 103 | ok |
| trellis-self | 164 | 15826 | 58 | false | 436 | 404 | ok |

All four paired-change expectations and every completeness/scope check
held. The trellis-self runtime/memory budget remains 10,000 ms / 1,024 MiB;
fixtures remain within 2,000 ms / 512 MiB. The historical Linux calibration
record remains in [`corpus-validation.md`](corpus-validation.md); this run
adds a second-platform check without changing thresholds or claiming
cross-machine timing equivalence.

The self-audit's trace is 39 complexity/erosion points (25 eroded production
functions, eroded mass share 0.144065), 19 duplication points (18 groups,
density 0.040882), and 0 cycle points (no groups). Production scope is 164
files / 15,826 source lines. Infrastructure and test debt do not offset
those points. Count saturation remains visible and provisional.

## Backlog disposition and release limits

Seeds stores each reviewed legacy item's `extensions.pivotDisposition`
(plan, date, disposition and reason). Existing descriptions and historical
plans are preserved. The decisions are:

| Disposition | Issues | Rationale |
|---|---|---|
| Superseded and closed | trellis-589a, trellis-98c0, trellis-7bae | Public named-tool readiness grading, model/cache variance and the os-eco overlay acceptance test were replaced. New evidence tests retain the lessons without restoring model grading. |
| Superseded and closed | trellis-8d8a, trellis-d02e | Factory-readiness verdicts and a maturity/rubric ceiling conflict with this product's scope and score direction. |
| Deferred, kept open | trellis-14df, trellis-788c | Target smoke/quality-gate execution is outside SPEC §8/§15. Testing this package does not authorize target execution. |
| Deferred, kept open | trellis-79c9, trellis-9aa1 | Standards expansion and automatic issue filing/dispatch require separate proposals using the new contracts. |
| Kept unchanged | trellis-7cb8, trellis-7ffe | Historical parents of completed plans; no completed plan was reopened or rewritten. |
| Resolved and closed | trellis-5fb5 | Full gates now pass in the restricted environment; the obsolete agent-trailer detector was retired. |
| Kept open | trellis-87d9 | A previously intermittent CLI history test failure remains worth investigating; passing this run does not disprove it. |
| Deferred, kept open | trellis-f999 | Abstraction research is uncalibrated and does not enter the score. |
| Kept open | trellis-831b, trellis-f6b0, trellis-b412 | Current calibration and evidence limitations described below. |

The separate provider-evidence plan `pl-43c5` / `trellis-8ac1` is not adopted
into this release. Its existing children and statuses remain intact.

Known limits remain explicit: large-repo count saturation is provisional
(`trellis-831b`); a path-mapped non-TS asset can conservatively mark cycle
coverage incomplete (`trellis-f6b0`); indirect budget wiring may be reported
only as configured (`trellis-b412`). None silently produces a clean required
dimension or lets infrastructure improve the structural score. The original
named-tool false-negative lesson (`trellis-589a`) is linked to the safeguard
and provider follow-ups. The old flake (`trellis-7bae`) is linked to the
current history flake rather than treated as evidence that retries fix it.

Seeds integrity validation reported zero failures and historical
bidirectional dependency warnings. `trellis-83b5` tracks investigation;
acceptance does not repair historical edges by reopening completed work.
