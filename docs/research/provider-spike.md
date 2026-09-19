# Reusable engineering-quality providers: spike 2

Research issue: `trellis-ff55`. Follow-up integration decision: `trellis-06f8`.
Maintenance-outcome validation remains `trellis-f999`.

**Result: reuse is technically promising, and the interpretation layer matters.**
Pinned jscpd finds a near-clone that the current detector misses. SonarJS provides
a different view of reasoning burden. dependency-cruiser detects declared boundary
violations. Knip adds export/file reachability evidence, but its candidates cannot
be treated as unnecessary code without an explicit entry-point and test model.

All experiments are standalone research harnesses. The public audit, SDK, scoring,
runtime dependencies, and production source are unchanged. Optional toolkits live
outside the repository. Installing toolkits can require network access; the actual
analysis runs use local tools. The harnesses write their research artifacts explicitly.

## Shared corpus and provenance

Base commit: `f3743bc0154ba032ef957a20dea678face1b3fa8`.

The shared manifest (archived with the production outputs in Git) freezes 162 production files,
including source and scripts, with individual content hashes. These contain 1,129
functions and 15,147 trellis code lines. The corpus SHA-256 is:

`420cdd12431c6c4e1badeb13917c39a4d9da02a6ab6cfb2ca3e801db4379a848`

[provider-corpus.mjs](provider-corpus.mjs) reproduces the manifest using the actual
configuration/discovery core. Each experiment records the same corpus identity or
per-file evidence and its own exact options, versions and runtime. jscpd runs on a
copy containing only those production files; SonarJS receives their text; the graph
and reachability probes run on the checkout with explicit selected files and entries.
These differences are intentional and documented, not silently treated as equivalent
execution environments. The graph probes have installed target dependencies available.

Constructed controls are stored as JSON strings and generated outside the production
tree. They do not contaminate the code being measured. Research `.mjs` files are outside
the TS/TSX production corpus. No hosted service, model review, target test execution,
or proprietary service account is involved in provider analysis.

## Findings

| Provider | Measured result | Decision |
| --- | --- | --- |
| jscpd 5.2.1 | Normalization detects renamed copies; AST similarity detects the edited-copy control missed by trellis | Advance to an integration contract and broader backend comparison |
| SonarJS 3.0.5 | Nested conditions score 6, equivalent guards 3, while both have CC 4 | Useful supplemental comprehension evidence; no new scoring weight |
| dependency-cruiser 17.3.8 | Finds the fixture's runtime/type-only cycles, forbidden dependency, and unresolved import | Useful for explicitly declared architecture rules |
| Knip 6.16.1 | Finds controlled dead file/export cases; 439 production symbol candidates need context | Opt-in reachability evidence, not an automatic deletion or quality penalty |

### Duplication: borrow the engine, own the accounting

At matched 50-token/3-line thresholds, using trellis's line classifier to union
all affected locations:

| Engine/mode | Groups or pairs | Affected production code lines |
| --- | ---: | ---: |
| trellis normalized | 124 groups | 2,320 |
| jscpd exact | 24 pairs | 452 |
| jscpd normalized | 91 pairs | 1,565 |
| jscpd normalized plus near-clone passes | 95 pairs | 1,813 |

These are coverage observations, not precision/recall results. Groups and pairs
are different units; token/literal semantics also differ. Both normalized engines
match an intentionally ambiguous pair of independent data builders. Similarity
does not establish a shared responsibility.

The actual 5.2.1 binary supports `--ignore-identifiers`, `--ignore-literals`,
`--max-gap-lines`, and `--similarity`. Default exact matching is therefore an
insufficient basis for the earlier rejection recorded in SPEC §5.3.

The accounting difference is concrete: two identical 14-line files yield jscpd's
reported duplication of 46.43%, but the union of affected code lines is 28/28,
or 100%. A provider's percentage cannot replace trellis density directly.

All five fixture-pair checks and three-run normalized stability comparisons passed.
Date metadata had to be excluded. Warm-run timings were roughly 103 ms for core
discovery/parse/detection, versus 26–35 ms for jscpd subprocess modes. The work differs:
trellis's parser is shared with other metrics, while a new backend would add its own
parse. This small run is not evidence of an equivalent end-to-end speedup. Memory,
multiworker behavior, cross-platform stability, and exhaustion were not measured.

[Full jscpd methods, raw outputs and reproduction](jscpd-provider-spike/README.md).

### Reasoning and correctness: separate evidence categories

Sonar cognitive complexity has maximum/median/p90 **23/1/6** on the corpus;
current CC has **19/2/7**. Their top-15 lists share five functions. That is a
different emphasis, not validation that one ranking is better.

The paired examples expose a limitation too: extracting helpers reduces cognitive
complexity without removing decisions, and two added forwarding layers still score
zero. It improves the view of nesting while leaving abstraction burden unresolved.

Three selected syntax-only bug rules (`no-identical-expressions`,
`no-identical-conditions`, `no-element-overwrite`) pass positive and negative controls.
They produce zero findings in trellis. This establishes no general correctness claim.
All 12 fixture cases and repeated evidence checks pass.

The metric adapter parses threshold-zero diagnostics and maps them to core functions.
That is a pinned research adapter, not a stable public metric API. Core TS is 6.0.3;
the provider resolves TS 5.9.3. Provider package metadata says `LGPL-3.0-only`, while
the shipped license/header identify Sonar Source-Available License v1.0. This is
documented conflicting evidence, not a legal interpretation or distribution decision.

[Full SonarJS methods, paired function metrics and reproduction](sonar-provider-spike/README.md).

### Architecture and unnecessary code: context determines meaning

dependency-cruiser represents every one of the 162 production files, with 176 nodes
including external/builtin stubs. It finds no violations of the three selected rules
in trellis. On the controlled fixture it finds both a runtime and a type-only cycle,
one domain-to-UI dependency, and one unresolved import; allowed dependencies remain
unflagged. Different cycle kinds retain their evidence rather than receiving the
same presumed runtime significance.

Knip reports no unused production files or unresolved imports under the explicit
entry-point model. It reports 258 export and 181 type candidates. Manual inspection
finds test-only helpers and unused barrel re-exports among them: tests are excluded
from the selected reachability model. These are not 439 confirmed instances of slop.

Both providers receive controlled JSON configuration; Knip's framework/tool plugins
are disabled. This sacrifices framework-specific knowledge. Installed dependencies,
JSON tsconfig and package metadata still influence analysis, so this is an opt-in
project-aware experiment rather than proof of the default zero-setup contract.

Three failures were especially instructive:

- Without its optional supported TS parser, dependency-cruiser returned a successful
  empty graph. The harness now asserts actual file coverage, not only exit status.
- A macOS `/var` versus `/private/var` mismatch made Knip report imported fixture
  files as orphaned. Canonicalizing the fixture path fixed the false positives.
- Omitting script entry points made research modules appear unused; adding the
  complete entry model removed those candidates.

Knip's raw file-record ordering also varies. Repeated normalized evidence matches
after sorting. Assertions pin the selected fixture finding sets and full production
graph coverage. dependency-cruiser uses supported TS 5.9.3; TS6 compatibility is not
established by its success on this corpus.

[Full architecture/Knip methods, configurations and reproduction](architecture-provider-spike/README.md).

## What trellis would contribute

This experiment supports a profile of evidence: duplication, reasoning burden,
declared architecture violations, correctness risks, and reachability candidates.
It does not support adding their counts together into a quality index. One problem
can trigger several providers, and absence can mean missing context or unsupported
analysis rather than good engineering.

A future provider contract should preserve source/tool/parser/config identity,
located raw observations, analysis coverage, and explicit failure states. Trellis
can then own scope normalization, overlap accounting, stable comparisons, and
evidence-based interpretation while delegating mature detection work.

The first implementation candidate is jscpd, conditional on testing canonical clone
groups, malformed input, deterministic limits, packaging, and platform behavior.
dependency-cruiser is a candidate for declared boundary checks, not an established
replacement for the existing graph resolver. Knip belongs in an optional contextual
report. SonarJS needs a distribution decision and maintenance-outcome validation.

This remains one repository plus authored controls, on one platform. No precision,
recall, developer-effort benefit, defect reduction, or universal determinism is
established. History/co-change analysis, mutation testing and broader external
corpora were not part of this spike. They remain possible later studies rather
than implied capabilities of the current audit.
