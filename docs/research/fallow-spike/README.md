# What trellis can borrow from Fallow

Research: `trellis-3577`, executed 2026-09-18 on macOS ARM64.

**Borrow the duplication-engine architecture and better finding identities first.**
Both address reproduced weaknesses in trellis. Borrow normalization and grouping
fixtures next. There is no demonstrated need to add another provider, replace
trellis's scoring, or port Fallow's full feature set.

This is executable research, not a production integration. No production source,
scoring version, runtime dependency, or audit behavior changed.

## Provenance and reproduction

- trellis: `dbea36fc87acecd609a3673cfe076f13acaf94b2`.
- Executed Fallow npm release: **3.27.0**, with its signed darwin-arm64 binary.
- Inspected source: [aeb92c9a0f54ec18a11b2522459688728abf53e2](https://github.com/fallow-rs/fallow/tree/aeb92c9a0f54ec18a11b2522459688728abf53e2).
  This checkout declares 3.27.0; no claim of independently verifying build provenance.
- [Tool provenance](tool-provenance.json) records npm artifact integrity values.
- [Harness](run.mjs) generates all controls; [results](summary.json) record observations
  and the SHA-256 of the generated fixture descriptions. The diverse near-copy and
  unrelated controls reuse the earlier jscpd spike's fixture data.

Install once outside the target, then run from trellis's root:

```sh
npm install --prefix /tmp/trellis-fallow-spike-tool --ignore-scripts --no-audit --no-fund fallow@3.27.0
bun run docs/research/fallow-spike/run.mjs /tmp/trellis-fallow-spike-tool/node_modules/.bin/fallow > /tmp/fallow-spike.json
```

Requires installed trellis dependencies and a configured Git author/committer.
Fixtures and two-commit Git repositories are created in owned temporary directories.
The harness disables fixture commit hooks/signing, preserves configured identity,
requests no-cache analysis and telemetry opt-out, and removes fixtures and Fallow's
base caches on successful completion. A process interruption may leave scratch.
The source download and npm acquisition required network; fixture runs used the
restricted execution environment. No formal syscall-level network audit was performed.

## 1. Duplication: avoid re-extending the same matching runs

Trellis hashes every 100-token window, compares every matching-window pair, extends
each pair left/right, and verifies group content repeatedly. Fallow's default
pipeline rank-reduces tokens, inserts unique file sentinels, builds a suffix array
using SA-IS, computes a longest-common-prefix array with Kasai's algorithm, and
extracts clone groups from LCP intervals. Its alternate rolling implementation is
environment-selected; it was not selected in this experiment.

Source pointers, relative to the pinned Fallow tree:

- `crates/engine/src/duplication_detector/detect/mod.rs`
- `detect/suffix_array.rs`, `detect/lcp.rs`, `detect/extraction.rs`
- `shingle_filter.rs` for eliminating files without repeated minimum-length shingles

The controls contain renamed copies of a 27-line function with 24 sequential
conditions. Both tools run semantic normalization with minimums of 100 tokens and
3 lines; their token definitions still differ.

| Copies | trellis tokens | trellis outcome | Fallow outcome |
| --- | ---: | --- | --- |
| 2 | 458 | Complete, one group | One group, two instances |
| 10 | 2,290 | Complete, one group | One group, ten instances |
| 40 | 9,160 | **100,000,000 match-work budget exhausted** | One group, forty instances |

Forty copies are only 1,080 code lines. This isolates the repeated-work failure
already reported on real repositories in `trellis-e55c`. Raising the budget is not
the first fix to try. Evaluate a suffix-array/LCP implementation over trellis's
existing token streams, retaining its group finalization and accounting where
compatible. Start with Fallow's algorithm structure and edge-case corpus.

This experiment establishes successful Fallow output versus trellis exhaustion,
not whole-engine asymptotic bounds or a portable speedup. Recorded timings compare
trellis's in-process duplication pass after parsing with Fallow's complete CLI
invocation; they are deliberately **not** used as a performance ranking. Output
materialization and clone-group counts can still be expensive with suffix arrays.
Require differential parity on complete current fixtures, same-file overlaps,
file boundaries, maximal groups and subsumption, plus new memory/work budgets
before changing the native engine. Do not adopt hash-only equality as proof of
normalized token equality; retain collision verification.

## 2. Finding identity: borrow the idea, fix its collisions

Fallow's `crates/api/src/audit_keys.rs::health_finding_key` uses relative path,
function name, and exceeded metric, omitting line numbers. The audit ledger checks
key-set membership. Trellis currently groups only by kind and path, pairs 1:1
groups, and reports every member of larger groups as new/resolved.

These are actual two-commit Fallow audits and trellis core report comparisons:

| Change in one file | trellis hotspot classification | Fallow complexity attribution |
| --- | --- | --- |
| Comment above unchanged `alpha` and `beta` | 2 new, 2 resolved | 0 introduced, 2 inherited |
| Add `gamma` beside `alpha` and `beta` | 3 new, 2 resolved | 1 introduced, 2 inherited |
| Replace sole `alpha` with differently sized `beta` | 0 new, 1 persistent | 1 introduced |
| Add class `B.run` beside existing `A.run` | 2 new, 1 resolved | **0 introduced; both rows inherited** |

Fallow reports one unique inherited complexity key in the last case although
there are two finding rows. That is a concrete key collision, not evidence that
the new method is safe. Other categories can still fail that audit; the experiment
does not claim an overall false pass.

Recommendation: versioned, per-kind structured identity with file, enclosing
lexical/class scope, function identity and metric. Preserve multiplicity and reject
ambiguous pairings. Anonymous functions, overloads, duplicate names, moves, and
renames need explicit semantics. Saved-report comparison should remain independent
of Git. Track under **`trellis-7cfd`**; the existing `facts.name` alone is insufficient.

Also borrow Fallow's regression controls for duplication attribution. Its clone key
includes participating paths, token/line counts and source-fragment hashes; it can
change when clone groups reshape. Fallow therefore demotes groups with no added-line
overlap in Git diffs. That repair is useful prior art, but cannot simply be copied
into trellis's Git-free report comparator. Content/group membership semantics need
their own design, rather than treating ordinal `clone-group-N` labels as identities.

## 3. Normalization and near clones: useful evidence, not drop-in scoring

- Both detect exact and renamed controls as one group.
- Two files containing only thirty import statements produce one group in trellis
  and in Fallow with import exclusion disabled. Fallow's default import exclusion
  removes the finding. Study this as an explicit versioned scope decision: common
  module wiring is often low-value duplication evidence.
- The diverse edited-function control produces zero native trellis groups. Fallow
  semantic mode finds an exact fragment; `--near` additionally finds a whole-function
  pair with similarity **0.89855**. The highly repetitive edited control does not
  gain a near group, so near mode is not uniformly better.
- The unrelated control produces no groups. One Fallow input is below its token
  minimum, so this is only a smoke negative, not a precision result.
- Plain repeated JSDoc prose produces no groups in either tool. This does not close
  `trellis-57aa`: tagged JSDoc and other trivia shapes were not tested here.
- The exact pair is **54/54 affected code lines** in trellis but **52/54 lines** in
  Fallow. Its AST token boundaries omit different source regions. Never replace
  trellis's density with the external percentage based on matching flag values.

The bounded near engine in `near.rs` uses 7-token shingles, 64-value MinHash
signatures in 16 bands, Jaccard verification at 0.80, and complete-link clustering.
It limits candidate work and reports skipped candidates. These techniques and the
non-transitive grouping tests are worth studying, but approximate candidate recall
and scope changes cannot silently become authoritative scoring. Existing jscpd
evidence already covers the near-copy use case; adding Fallow is not justified by
this control alone.

`families.rs` groups multiple clone groups by their participating file sets.
Borrow that as a presentation improvement if real reports are repetitive; do not
replace content-identity groups or union-of-lines accounting. Its generic extraction
suggestions do not establish that the instances share a responsibility.

## Decision and validation

1. Prioritize the native duplication algorithm investigation in `trellis-e55c`.
2. Fix baseline identities in `trellis-7cfd`, including the collision controls above.
3. Reuse tokenizer/import/overlap and near-cluster tests when evaluating those changes.
4. Defer a Fallow provider, more score dimensions, and automatic refactoring advice.

Fallow is MIT-licensed, copyright 2026 Bart Waardenburg. No Fallow code is copied
in this spike. A later source port must preserve the applicable copyright/license
notice. The harness is independently written and exercises public CLI behavior.

The harness asserts the central attribution and exhaustion outcomes. Two final runs
produce identical recorded observations after removing timings. Lint, typecheck,
all 2,114 tests, and the nine-gate `check:all` suite pass. These constructed controls
support targeted engineering decisions, not a claim of general detection accuracy
or maintenance-outcome validity.
