# Bounded native duplication contract

Plan pl-da6d, step 5 (trellis-271c). This is the frozen migration contract,
not production cutover approval. Steps 6–8 build a candidate outside the audit;
step 9 must prove the contract before step 10 replaces the single native engine.

## Semantics and oracle

The shared TypeScript AST token collector is unchanged: normalized token kinds,
identifier/literal normalization, imports and current JSDoc behavior all remain.
A match requires **100 tokens and 3 lines per member**. Matches never cross file
or source-set boundaries. Production/test detection and code-line denominators
remain separate; other source sets are not detected. Near edits split exact
normalized runs; no fuzzy analysis is added.

Every left-maximal pair extends to its maximal equal right boundary. Equal
content and length merge into a group; matching a shared prefix never transitively
merges unequal branches. Same-file repeats remain eligible, including overlap.
After the per-member line minimum, strict token-contained members are removed;
groups with fewer than two members are removed. A group disappears when every
member is strictly token-contained in some member of another eligible group.
Containment uses tokens, not overhanging line ranges. Equal ranges are not strict
containment. Survivors retain canonical path/line ordering and group numbering.
The numerator is the union of covered **code-classified** lines, never the sum
of member line spans; comments and blanks are excluded even inside a match.

`src/metrics/tests/duplication-oracle.ts` independently enumerates every eligible
pair and finalizes groups, with no rolling hashes, suffix index or production
finalizer. Its 2,500-token ceiling keeps it a small-input test oracle. It exposes
both raw local token intervals/content and finalized groups/line locations.
`duplication-accounting.ts` independently counts covered code lines. Neither is
imported by a production audit. These tests certify 99/100/101 tokens, 2/3 lines,
maximal branches, overlapping/contained periodic runs, repeated single kinds,
empty streams, file boundaries, zero-valued token kinds (not sentinels), source
sets, discovery-order reversal, exact/renamed/divergent code and line unions.

The original trellis-3577 generator is retained: 24 `if` branches make each
copy **229 tokens / 27 code lines**. Two and ten copies complete in the old
engine and agree with the exhaustive oracle at one 229-token group containing
all copies (54 and 270 unique affected lines). Forty copies (9,160 tokens)
exhaust the old **100,000,000 token-comparison** cap. That partial output is never
an oracle. The forty-copy candidate must complete with one group, forty exact
27-line members and 1,080 unique code lines, supported by the explicit source
construction and smaller complete controls.

## Work accounting v2 (candidate and eventual analyzer 0.2.3)

The replacement preserves the `maxTokens`/`maxMatchWork` option names but explicitly
versions their meaning with the analyzer/native tool+adapter version. Scoring
and report schema 1.2.0 remain unchanged. `maxMatchWork` becomes a budget for
**all deterministic detector work units**, not an equivalent count of old
extension comparisons. Existing callers can still lower both limits. Options
must be finite nonnegative integers; attempts to raise the frozen hard ceilings
are rejected, never interpreted as disabling guards. No runtime engine selector
or new CLI flag is introduced.

The executable numbers are in `manifest.json`; the required charges are:

| Phase | Required unit charges and cancellation checks |
| --- | --- |
| Input / indexing | Each stream and each visited token/AST collection node; each index-array slot visited in initialization, rank/sort passes and LCP construction; every comparison in non-counting sorts and token equality checks |
| Extraction | Each LCP/interval stack visit, push/pop, content/context probe and occurrence enumerated; reserve group/member capacity before retaining it |
| Materialization | Each retained group/member visited, location lookup, line-minimum decision and sort comparison |
| Finalization / accounting | Each containment/range query or interval event processed, each sort comparison and each covered/classified line visited for the union |

A unit is charged **before** that operation; batch reservations charge all slots
before allocation/initialization. Counts include failed probes. Phases share one
100M ceiling; phase counters and configurable lower phase limits permit tests
to force each failure. Implementation-specific extra charges are allowed and
must be documented in the counter implementation; required charges cannot be
omitted. Cancellation is checked before and after each phase and at most every
1,024 charged units. No token loop, comparison sort, interval traversal or
finalization sweep may run outside the accounting seam. Shared parsing already
belongs to the inventory; candidate-owned collection/index/storage is bounded.
The end-to-end RSS gate also accounts for the inventory, which is not claimed
to fit a detector-only allocation limit.

| Hard bound per source set | Limit |
| --- | ---: |
| Normalized input tokens | 2,000,000 |
| Input streams (including empty streams) | 100,000 |
| Total work units | 100,000,000 |
| Live numeric scratch cells (32-bit cells) | 32,000,000 |
| Retained candidate groups | 200,000 |
| Retained candidate member occurrences | 1,000,000 |

Token/stream limits are checked before concatenation or index allocation;
collection must stop at the first proven excess rather than constructing all
oversized streams. Index terminators are distinct from every token and from one
another; their cells count toward allocation reservations, not source tokens.
All limits apply cumulatively across intermediate and final candidate records,
not just the emitted group count. Released numeric scratch can be reused, but
unbounded JS-array growth cannot stand in for accounted storage.

Any limit or cancellation produces located **incomplete** evidence naming the
phase/cap. An unfinished extraction/materialization/finalization cannot publish
unvalidated groups as completed output; discarding uncommitted groups is valid
only with the explicit incomplete result. Empty incomplete output is never a
complete zero. Tests must force every phase, the token and allocation/output
limits, and already/mid-operation cancellation. No default native scratch,
subprocess, network, target execution or model is introduced.

## Frozen corpus and acceptance

`manifest.json` pins trellis at the delivered identity milestone, all eleven
in-repo fixtures, `hono/src`, and `zod/packages/zod`. Zod uses the source HEAD
resolved during preparation, not an older easier release. File counts, byte
counts and content digests describe the exact source trees. Source selection
uses the normal workspace configuration/discovery and shared token collector
at each declared scope for **both** engines. No dependencies are installed in
the target; unresolved import metrics do not prevent duplication-only acceptance.
No operator-prepared just-bash/pi-mono snapshots were found among the available
project checkouts or temporary research corpora; they are not claimed measured.

Preparation host: Apple M4 Pro, macOS ARM64, Bun 1.3.14, TypeScript 6.0.3.
Prepared root for this execution: `/tmp/trellis-duplication-corpus.bzWozh`.
The offline verifier passed for all fourteen entries before candidate work.
Hash: SHA-256 of JSON-serialized path-sorted `[relative path, content SHA-256]`
pairs; metadata/timestamps are excluded, symlinks rejected. The verifier only
reads files and fails closed on a missing or changed snapshot.

Predeclared acceptance is three fresh-process runs per engine/input, median
wall time and maximum process peak RSS. Core timings exclude discovery/parsing
for both engines; end-to-end timings include them for both. Record core and
overall wall times separately, plus phase work, groups and occurrences. A run
has a 30-second external watchdog; watchdog termination is failure, not a
complete detector result. Pinned trellis, Hono and Zod limits: **5,000 ms core,
10,000 ms end-to-end, 1,024 MiB peak RSS**. Each mini-fixture and each 2/10/40-copy
control: **2,000 ms core/end-to-end, 512 MiB peak RSS**. These use the existing
fixed-corpus 10s/1GiB self and 2s/512MiB fixture conventions, with a separate
core budget. They must not be raised to obtain acceptance.

All complete old inputs must agree exactly in canonical maximal groups,
normalized-token membership/count, line locations, affected-line unions and
source-set metrics; after cutover their native scores must also agree.
The old backend is a truth reference only when it completes. Forty-copy, Hono
and Zod duplication must be complete within the declared candidate limits;
partial old results supply no recall claim. Use the independent oracle,
construction invariants and complete reference checks where affordable.
Repeated candidate runs must have identical measurement payloads. Unavailable
inputs, unexplained deltas, or any exceeded bound block cutover; record an issue
instead of changing expectations. Fallow speed/precision is not an oracle.

## Reproduction (preparation is separate from analysis)

Create a fresh directory, called `$corpus_root` below. From a trellis checkout
containing the recorded local commit, archive trellis and acquire the other
pinned source archives; unpack each into the named directory. No target scripts
or installation commands are used:

```sh
mkdir "$corpus_root/trellis" "$corpus_root/hono" "$corpus_root/zod-current"
git archive 9b894a82b46ff84d3842bc05c7ebd225eca5aced | tar -x -C "$corpus_root/trellis"
curl -fL https://codeload.github.com/honojs/hono/tar.gz/cee5b88ac177755768cd81adda1feb5547eff3b8 -o "$corpus_root/hono.tar.gz"
curl -fL https://codeload.github.com/colinhacks/zod/tar.gz/59bbc03e10c636b9eb3c393dfeb552819774ec21 -o "$corpus_root/zod.tar.gz"
tar -xzf "$corpus_root/hono.tar.gz" --strip-components=1 -C "$corpus_root/hono"
tar -xzf "$corpus_root/zod.tar.gz" --strip-components=1 -C "$corpus_root/zod-current"
```

With network disabled, verify inputs and run the small oracle:

```sh
bun docs/research/native-duplication/verify-corpus.mjs "$corpus_root"
bun test src/metrics/tests
```

The later step-9 harness will consume this manifest without acquisition. The
production rolling-window engine stays in place until that acceptance passes.
No Fallow executable or runtime dependency is required. Fallow 3.27.0 source
commit `aeb92c9a0f54ec18a11b2522459688728abf53e2` is reference material only;
no source has been ported here. Any adapted source must retain its MIT notice
in a checked-in `docs/research/native-duplication/NOTICE` and a source-file
provenance comment before it can be accepted.
