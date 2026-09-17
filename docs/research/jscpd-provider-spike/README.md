# jscpd provider spike (trellis-ff55)

jscpd **5.2.1** is a viable candidate for further integration work. Its actual
Darwin ARM64 binary supports identifier/literal normalization and near-clone
flags. The historical SPEC comparison using default exact matching did not
exercise those capabilities. This experiment does not replace the audit engine
or change scoring.

## Reproduce

Run from the repository root with Bun and a locally installed jscpd 5.2.1 binary:

```sh
JSCPD_BINARY=/absolute/path/to/jscpd bun docs/research/jscpd-provider-spike/run.mjs
```

Alternatively install the pinned package in a temporary directory first:

```sh
mkdir -p /tmp/trellis-jscpd-spike
npm install --prefix /tmp/trellis-jscpd-spike jscpd@5.2.1
JSCPD_BINARY=/tmp/trellis-jscpd-spike/node_modules/.bin/jscpd bun docs/research/jscpd-provider-spike/run.mjs
```

The original run reused the cached `jscpd-darwin-arm64@5.2.1` binary; no network
installation was needed. `summary.json` records the executable hash, OS/CPU,
base commit, source manifest hashes, options, timings, assertions and repeat
hashes. The executable hash depends on whether a native binary or npm launcher
is supplied. The runner verifies the exact reported version.

Working files and reports go in `/tmp/trellis-jscpd-spike`; checked-in artifacts
in this directory are refreshed. `fixtures.json` stores labeled source pairs;
`production-inventory.json` stores content hashes of the actual copied inputs.
`sharedCorpusSha256` uses the parent experiment's sorted path/NUL/hash/newline
protocol. Raw JSON reports preserve located evidence and snippets. Generated
fixtures live outside the repository so they cannot contaminate its audit.

## Method

Copy the production file set selected by trellis discovery into an isolated
temporary directory. No project configuration, package manifests or dependencies
are copied. Parse that same inventory with the existing core and invoke jscpd
with explicit empty config, comments excluded, 50-token/3-line thresholds,
gitignore disabled, one worker and a 100 MB file limit. Check three modes:
exact; identifier/literal normalization; normalization plus gap merging at two
lines and AST similarity at 0.85.

Repeat each core/provider run three times. For stability comparison only, strip
volatile date/time metadata (the observed field is `statistics.detectionDate`),
canonicalize object keys and sort clone records. Timings are excluded. All
fixture checks and normalized repeated-evidence checks passed. This establishes
repeatability for these inputs/options/platform, not a universal determinism
claim. Multiworker/platform behavior and resource exhaustion were not tested.

## Fixture observations

| Case | trellis groups | jscpd exact pairs | normalized pairs | near pairs |
| --- | ---: | ---: | ---: | ---: |
| Exact copied function | 1 | 1 | 1 | 1 |
| Renamed copy | 1 | 0 | 1 | 1 |
| One inserted logging statement | 0 | 0 | 0 | 1 |
| Unrelated algorithms, both above threshold | 0 | 0 | 0 | 0 |
| Independent data builders with matching structure | 1 | 0 | 1 | 1 |

The last case is intentionally ambiguous: structural similarity alone does not
establish shared responsibility or justify extracting an abstraction. The near
fixture splits exact runs below threshold; AST similarity recovers the pair.
These five pairs are diagnostic examples, not a precision/recall benchmark.

## Production observations

The copied corpus contains 162 production files at base `f3743bc`, comprising
15,147 trellis code lines. jscpd reports 154 sources: it does not count files
below its token threshold in its source statistics.

| Engine/mode | Groups or pairs | Union of affected trellis code lines |
| --- | ---: | ---: |
| trellis normalized | 124 groups | 2,320 |
| jscpd exact | 24 pairs | 452 |
| jscpd normalized | 91 pairs | 1,565 |
| jscpd normalized + near | 95 pairs | 1,813 |

**Counts are not directly comparable:** trellis emits groups; jscpd emits pairs.
The affected-line column unions both members of every provider pair and filters
through trellis's code-line classifier. This provides comparable location
coverage, not ground-truth recall or proof that one detector is better.
Normalization also differs: trellis collapses all literal kinds; jscpd preserves
literal categories. The parsers and token boundaries differ.

Do not import jscpd's percentage as trellis's density. For the two identical
14-line fixture files, jscpd reports 13 duplicated lines and 46.43%, while the
union of affected code lines is 28/28 = 100%. Both raw accounting systems are
preserved in the artifacts. All scored numerator/denominator rules must remain
explicit in a provider adapter.

Observed medians were roughly 0.1 seconds for core discovery/parse/detection and
0.03 seconds for each jscpd subprocess. `summary.json` has precise observations.
The core timing includes shared parsing that other audit metrics already need;
jscpd includes subprocess startup and JSON reporting. Warm caches, tiny corpus,
three sequential runs and different work make these illustrative, not a product
speedup claim. Memory was not measured.

## Decision

Reopen the backend choice with a broader labeled corpus. A provider adapter can
reuse jscpd while trellis retains inventory selection, affected-line accounting,
provenance, stable evidence, completeness reporting and scoring. Native
subprocesses are offline and model-free here; adopting one inside the default
core would explicitly revise the current stricter architecture contract.

Before replacing the current detector, test group reconstruction, overlap
handling, scope boundaries, unsupported/malformed input fallback, native
packaging, larger corpora, multiworker stability and deterministic resource
limits. Higher counts are not evidence of better precision or useful findings.
No runtime dependency, audit behavior or score was changed by this spike.
