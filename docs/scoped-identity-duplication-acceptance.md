# Scoped identity and bounded duplication release acceptance

Plan **pl-da6d**, parent **trellis-adab**, final acceptance **trellis-12c1**.
Executed on Apple M4 Pro / macOS ARM64 with Bun 1.3.14 and TypeScript 6.0.3.
This record covers the delivered analyzer 0.2.3, report schema 1.2.0 and unchanged
scoring 0.2.0-provisional. No publication or push is part of this delivery.

## Requirements and executed evidence

| Step | Delivered requirement | Evidence |
| --- | --- | --- |
| 1 / trellis-9302 | Versioned scoped identity and conservative historical compatibility | [Identity contract](hotspot-identity.md); `src/contract/hotspot-identity.test.ts` |
| 2 / trellis-3d6b | Shared-AST identity, named ancestry and explicit propagated ambiguity | `src/syntax/identity.test.ts`, `src/metrics/hotspot-identity.test.ts`; producer parity in the identity contract |
| 3 / trellis-7cfd | Scoped matching without multiplicity loss | `src/compare/hotspot-identity.test.ts`: four attribution controls, duplicate keys, anonymous functions, CC edits and historical fallback |
| 4 / trellis-61d7 | Saved-report, policy, CLI/SDK, fleet and SQLite parity | `src/client/hotspot-parity.test.ts`; [surface result matrix](hotspot-identity.md#surface-acceptance-trellis-61d7) |
| 5 / trellis-271c | Frozen semantics, independent oracle and numerical resource contract | [Frozen contract and manifest](research/native-duplication/README.md); `src/metrics/tests/duplication-oracle.test.ts` |
| 6 / trellis-9b01 | Bounded suffix-array/LCP primitives | `src/metrics/duplication-suffix.test.ts`; exhaustive suffix and LCP comparisons, sentinels and budget guards |
| 7 / trellis-4c41 | Maximal content-identical clone extraction | `src/metrics/duplication-extract.test.ts`; raw membership, legacy ordinal parity, hash-collision and overlap controls |
| 8 / trellis-885c | Whole-pipeline work, allocation, output and cancellation bounds | `src/metrics/duplication-candidate.test.ts`; forced failure in every phase, final accounting, token/stream/output/allocation ceilings and cancellation |
| 9 / trellis-b594 | Pre-cutover correctness and mandatory corpus resource proof | [Executed candidate acceptance](research/native-duplication/acceptance.md), `results.json` and `raw-proof.json` beside it; committed before production adoption |
| 10 / trellis-e55c | Single native engine, version transition and unchanged complete-input scores | [Cutover acceptance](research/native-duplication/acceptance.md#production-cutover-step-10-trellis-e55c), source-bound `cutover-results.json`, reproduced `cutover-raw-proof.json` and `score-proof.json`; `src/client/duplication-cutover.test.ts` and `src/metrics/duplication-detect.test.ts` |
| 11 / trellis-12c1 | Combined end-to-end release control and final local gates | `src/client/hotspot-parity.test.ts`, forty-copy control described below; full gates and fixed-corpus validator |

The combined control puts forty named 27-line functions in separate files, saves a
baseline, then inserts a comment above one unchanged function. SDK audit and
saved comparison retain **40 persistent / 0 new / 0 resolved** hotspots, one
229-token clone group with forty members and **1,080 unique affected code lines**.
Raw metrics and score are unchanged. CLI audit/baseline and saved compare return
exit **0** and match the SDK. CLI and SDK fleet select the saved baseline from
separate explicitly requested SQLite databases and agree on measurement/policy.
Stateless runs preserve source/config bytes and create no database.

The same suite retains the original four controls: comment shift passes (exit
0); adding gamma, replacing alpha with beta, and adding B.run beside A.run fail
`failOnNew` (exit 2). Duplicate/ambiguous identities remain conservative and
preserve multiplicity. Schema 1.0.0/1.1.0 and analyzer 0.2.2 artifacts still load;
crossing identity/analyzer/resource bases requires a fresh baseline. Unknown or
malformed identities are rejected, not silently treated as historical.

## Validation

```sh
bun run lint
bun run typecheck
bun test
bun run check:all
bun scripts/validate-corpus.ts
bun test src/audit/offline.test.ts src/client/hotspot-parity.test.ts src/client/duplication-cutover.test.ts
```

The final full suite passes **2,212 tests / 0 failures** across 213 files,
and `check:all` passes **9/9 gates**. The current self-audit remains **index 44**,
complete, at 951 ms median and 577 MiB peak in the fixed-corpus run.
All required gates pass without loosening file-size, debt or coverage budgets.
`scripts/check-all.ts` and golden artifacts are unchanged. The fixed-corpus
validator passes its behavior, time and RSS criteria, including the current
self-audit. The independent raw proof and full-audit score proof were rerun
against all fourteen verified source snapshots and reproduced their checked-in
JSON records exactly. The cutover resource record binds the current engine
source hashes, covers seventeen inputs with three fresh processes per engine,
and passes every frozen limit. Reproduction commands and snapshot fingerprints
are in the linked native-duplication acceptance record.

`src/audit/offline.test.ts` denies subprocess/fetch boundaries, removes tools and
credentials, and verifies byte-preserving CLI/SDK/fleet audits. The production
forty-copy regression uses an empty PATH and an inert target prepare script.
`src/audit/cross-provider.test.ts` and `src/client/cross-provider-surfaces.test.ts`
verify optional-provider evidence remains unscored through the same core.
No new runtime dependency, model, target execution, audit network, Git matching
requirement, tokenization change, threshold change or score recalibration lands.

## Limits and residual work

The engine retains 100-token/3-line minima and a **2M-token per-source-set** limit,
with whole-pipeline 100M work, 32M numeric-cell, 100k-stream, 200k-group and 1M-member
ceilings. Exhaustion is located incomplete evidence without fabricated zero
measurements. The 22.7M-token OpenClaw observation is outside the supported input
limit. Hono and Zod now complete duplication but retain unrelated graph
incompleteness; their index changes represent better measurement, not cleanup.
No just-bash/pi-mono snapshot or non-macOS resource run is claimed.

Out-of-scope observations remain explicit in Seeds: **trellis-92b4** (large audit
memory/report overhead), **trellis-57aa** (versioned JSDoc tokenization),
**trellis-42ad** (dynamic import graph incompleteness), **trellis-a98b** (unbuilt
workspace export resolution), and **trellis-83b5** (Seeds dependency warnings).
Near clones, import filtering, Fallow installation/provider promotion and formula
calibration remain excluded. The SA-IS implementation is original; no third-party
implementation source was ported, so no new attribution notice is needed.
