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
