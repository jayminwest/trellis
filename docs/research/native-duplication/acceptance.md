# Native duplication candidate acceptance

Plan pl-da6d step 9, trellis-b594. Frozen inputs/limits: [manifest.json](manifest.json).
Machine-readable observations and candidate source hashes: [results.json](results.json).
Independent raw membership proof: [raw-proof.json](raw-proof.json).

The 17-input, three-fresh-process-per-engine run **passes** every declared
resource and semantic check. All candidate source sets complete. All 30 source
sets for which the original engine completes have identical raw content/member
intervals and finalized scope payloads, including group IDs, token counts, line
locations, code-line unions and diagnostic-file metadata. Candidate measurement
payloads and operation counters repeat exactly across all three runs. The
remaining four source sets exhaust the original engine; its partial groups are
not a truth oracle. Candidate raw members independently pass token equality,
file-boundary and left/right-maximal-partner checks in every one of the 34 sets.

## Indexing correction required by the fixed corpus

The first Zod test-set probe (391,464 tokens) exhausted the frozen 100M work cap
in prefix-doubling indexing, before extraction. This blocked acceptance and was
filed as trellis-e4f2. The replacement is original SA-IS induced sorting with
Kasai LCP, not a raised cap or an easier corpus. LMS reduction halves the problem
size, giving logarithmically bounded recursion and linear index work/storage;
all operations still pass through the same guard. The exhaustive suffix/LCP
oracle, extraction differential tests and whole-pipeline tests pass unchanged.
Zod's test set now completes in 73,123,580 total work units; its production set
uses 46,816,394. No Fallow implementation source was copied or executed.

## Executed measurements

Apple M4 Pro, macOS ARM64, Bun 1.3.14 (canary build 11a2e2c20), TypeScript 6.0.3.
Core excludes discovery/parsing equally; overall includes configuration,
discovery/parsing and duplication measurement equally, excluding runtime/module
startup. RSS is process peak from Bun's getrusage value, normalized from bytes on
Darwin (verified against resident memory) and KiB on Linux. Every worker has the
frozen 30-second watchdog. No target scripts, dependency installations, Fallow,
models or audit-time network access are used.

All large inputs have 5,000 ms core / 10,000 ms overall / 1,024 MiB peak limits;
mini-fixtures and copy controls have 2,000 ms / 2,000 ms / 512 MiB limits.
Times below are medians of three runs; RSS is the largest peak of those runs.
The original engine's times on incomplete sets are not complete-analysis speed
comparisons. The candidate improves feasibility, not every input's elapsed time.

| Input | Original core ms | Candidate core ms | Candidate overall ms | Candidate peak MiB | Original complete (prod/test) |
| --- | ---: | ---: | ---: | ---: | --- |
| trellis-self | 154.4 | 332.7 | 664.0 | 524.8 | yes/yes |
| hono-src | 441.2 | 392.9 | 746.3 | 565.4 | no/yes |
| zod-package | 484.2 | 611.7 | 1023.9 | 720.8 | no/no |
| clean-small | 0.8 | 1.7 | 11.3 | 123.8 | yes/yes |
| clone-base | 1.8 | 3.1 | 13.9 | 129.6 | yes/yes |
| clone-removed | 0.8 | 2.2 | 12.0 | 124.3 | yes/yes |
| branch-base | 0.7 | 2.1 | 11.5 | 122.1 | yes/yes |
| branch-grown | 1.0 | 2.4 | 13.4 | 125.5 | yes/yes |
| acyclic | 0.7 | 1.8 | 11.1 | 122.5 | yes/yes |
| cyclic | 0.8 | 1.8 | 11.0 | 122.4 | yes/yes |
| dilution-base | 1.8 | 3.4 | 16.0 | 130.9 | yes/yes |
| dilution-grown | 2.0 | 5.3 | 21.1 | 134.7 | yes/yes |
| test-separation | 1.7 | 3.4 | 14.9 | 129.2 | yes/yes |
| incomplete-parse | 0.5 | 1.2 | 9.8 | 121.2 | yes/yes |
| copies-2 | 6.3 | 4.3 | 11.2 | 131.3 | yes/yes |
| copies-10 | 47.1 | 10.2 | 20.3 | 142.2 | yes/yes |
| copies-40 | 154.9 | 25.2 | 41.7 | 154.7 | no/yes |

The formerly incomplete sets are Hono production, Zod production and tests,
and the forty-copy production control. The latter now returns one maximal
229-token group with all forty 27-line members and 1,080 unique code lines.
The independent small oracle covers exhaustive pairs, nested/periodic/overlap
controls, source boundaries, 100-token/3-line minima, line unions, forty
fixed-seed context variants and their reversed input orders. An explicit
polynomial-hash collision control stays separated under input permutations.
This evidence makes no Fallow-derived precision or recall claim.

## Reproduction and update gate

Prepare the exact source snapshots using [README.md](README.md), then run from
the trellis root with network disabled. The raw-proof command temporarily adds
an export to a copy of the pinned **trellis engine**, erases its types and uses
absolute imports; its algorithm is unchanged. The owned temporary module is
removed after loading. No target source tree is changed, and all fourteen tree
fingerprints are rechecked after both runs.

```sh
bun docs/research/native-duplication/run.mjs "$corpus_root" "$results_dir"
NODE_PATH="$PWD/node_modules" bun docs/research/native-duplication/raw-proof.mjs "$corpus_root" "$results_dir/raw-proof.json"
bun test src/metrics/duplication-suffix.test.ts src/metrics/duplication-extract.test.ts src/metrics/duplication-candidate.test.ts
cp "$results_dir/results.json" docs/research/native-duplication/results.json
cp "$results_dir/raw-proof.json" docs/research/native-duplication/raw-proof.json
```

Both harnesses must exit zero. Payload files emitted alongside `results.json`
retain full scope/group evidence for local inspection; the checked-in summary
binds those payloads by SHA-256 and records every repetition and source-set
operation/output count. The checked-in raw proof similarly records content and
membership digests, exact-reference status and independent comparison counts.
The manifest and budget ceilings must not be changed to obtain acceptance.
Production cutover is step 10 and remains a separate change, with native score,
policy, CLI/SDK and zero-footprint checks required there.

## Production cutover (step 10, trellis-e55c)

Analyzer 0.2.3 now uses this engine through `analyzeDuplication`; the token-stream
entry point delegates to the same bounded implementation. The old detector and
finalizer are retained only under `src/metrics/tests/` as reference code. The
candidate filename is historical, not a second selectable runtime backend.

[cutover-results.json](cutover-results.json) repeats all 17 inputs, three fresh
processes per engine, against the final cutover source hashes. Every frozen
resource and complete-reference payload check passes.
[cutover-raw-proof.json](cutover-raw-proof.json) repeats the independent raw
membership/maximality proof. No manifest, ceiling or scoring constant changed.

| Input | Core median ms | Overall median ms | Peak MiB |
| --- | ---: | ---: | ---: |
| trellis-self | 329.7 | 659.5 | 523.2 |
| hono-src | 402.3 | 736.4 | 549.1 |
| zod-package | 610.7 | 1020.8 | 877.1 |
| copies-40 | 24.5 | 39.3 | 155.3 |

[score-proof.json](score-proof.json) compares complete production audits against
the pinned pre-cutover core on all fourteen source snapshots. All formerly
complete metrics and unchanged-input score objects agree exactly. Hono's index
changes 89 → 83 and Zod's 92 → 88 solely because previously incomplete duplication
is now measured. Their graph metrics remain incomplete: these are measurement
coverage improvements, not source cleanup or claims of fully complete audits.
The pinned trellis index remains 44. Scoring is still 0.2.0-provisional.

`src/client/duplication-cutover.test.ts` proves forty-copy CLI/SDK measurement
parity, 1,080 affected lines, production/test separation, forced unmeasured
exhaustion, unchanged target contents and no default database. Prior 0.2.2 reports
remain readable; analyzer changes and disguised work-option changes both refuse
scored comparison with policy exit 2. The existing optional-provider isolation
and native offline suites exercise the production audit path.

To reproduce the cutover records, use the preparation and network-disabled
commands above with a new output directory, then copy `results.json` and
`raw-proof.json` to their `cutover-` names. The additional score proof is:

```sh
NODE_PATH="$PWD/node_modules" bun docs/research/native-duplication/score-proof.mjs "$corpus_root" "$results_dir/score-proof.json"
cp "$results_dir/score-proof.json" docs/research/native-duplication/score-proof.json
```

The supported input limit remains 2M normalized tokens per source set. The
22.7M-token OpenClaw observation is outside that limit. No just-bash/pi-mono or
additional operating-system resource validation is claimed here.
