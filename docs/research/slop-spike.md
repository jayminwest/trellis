# Structural slop hypotheses: spike 1

Research issue: `trellis-2d45`. Protocol: `slop-hypotheses-v1`.

**Result:** syntax can expose added machinery and repeated decisions that
maximum function complexity misses. These probes cannot yet establish that
the machinery is unnecessary, or that differing decisions are incoherent.
Raw forwarding counts are particularly unsuitable for scoring.

This is a feasibility and falsification spike, not empirical validation of
maintainability. It adds an opt-in research runner, three candidate signals,
and 13 tests with positive examples, counterexamples, and invariance checks.
The audit, SDK, report contract, and scoring formula remain unchanged.

## Reproduce

From this repository, with its dependencies installed:

```sh
bun test src/research/slop-spike.test.ts
bun scripts/spike-slop.ts .
bun scripts/spike-slop.ts /path/to/another/workspace > /tmp/slop-spike.json
```

The runner reads the target's audit configuration and reuses discovery and
the shared syntax inventory. It does not install target dependencies, run
target commands, use Git, call models, or write to the target. Shell
redirection explicitly saves its JSON output. This is an internal research
command, not a new public CLI command or SDK export.

The [saved self-audit](slop-spike-self-audit.json) was generated on top of
base commit `9ffe0158261bc96c45bdc1f1baf000df65fe8dda`, including this spike's
production source. It uses TypeScript 6.0.3. Regenerate explicitly with:

```sh
bun scripts/spike-slop.ts . > docs/research/slop-spike-self-audit.json
```

## Hypotheses and operational definitions

### H1: argument-preserving wrappers expose abstraction burden

Observe functions whose entire body returns a single call, passing each
identifier parameter exactly once in declaration order. Expression-bodied
arrows count. Parentheses and comments do not affect matching. Report the
location, name, callee expression, parameter count, and async modifier.

Exclude default values, destructuring, rest/spread, reordered or transformed
arguments, extra statements, optional calls, and `return await`. Zero-argument
wrappers count. Async wrappers are labeled because promise behavior can
differ. Target expressions are source text, not resolved call graph edges.

**Prediction:** adding forwarding layers increases this count while maximum
CC can stay constant. The paired fixture confirms that narrow prediction:
direct implementation has zero forwarding sites; two added layers produce
two; maximum CC remains 1.

**Counterexample:** an intentional SDK facade and a `Set.has` callback also
match. Receiver binding, property getters, public API stability, transaction
boundaries, and naming can all supply value or behavior this probe cannot
judge. Defaults also make some genuinely thin wrappers invisible. Therefore
this count is not a measure of unnecessary abstraction.

### H2: repeated dispatch vocabularies expose possible change amplification

Collect switches with at least two distinct static string/numeric case
labels. Group switches with identical label sets, independent of ordering,
discriminant spelling, or case body text. Report every location and the
number of sites and files. Preserve whether each switch has a default.

Reject the entire switch if any label is dynamic, including enum property
accesses. String and numeric labels are distinct. Top-level and nested
switches count exactly once. Tests are outside the production probe.

**Prediction:** repeating a decision in two files creates a two-site family;
consolidating to one switch removes that family. The fixture confirms this
response, but does not establish semantic equivalence of a real refactor.

**Counterexample:** traffic lights and paint colors can share labels but
represent independent concepts. Conversely, converting switches to repeated
lookup tables hides the repeated decision from this probe. These are tested
limitations, not exceptions silently filtered out of the benchmark.

### H3: near-matching dispatch vocabularies expose possible incoherence

Compare eligible switches pairwise. Report pairs with at least two shared
labels, differing sets, and Jaccard similarity at least 2/3:
`|intersection| / |union|`. Show shared and side-specific labels and defaults.
The threshold is exploratory, uncalibrated, and not a probability.

**Prediction:** switches over `{json, md, text}` and `{json, md}` expose the
unmatched `text` case. The fixture confirms the observation. A legitimate
subset of supported operations produces exactly the same observation; a
default may handle the difference correctly. No bug or missing requirement
is inferred.

Pair comparison is explicitly incomplete above 1,000 eligible switches;
the other evidence remains available. Files with parse diagnostics are
skipped and named. Syntax-inventory completeness and diagnostics are retained.
"Complete" means the specified probe ran, not that it detects all possible
abstraction, duplication, or consistency problems.

## What trellis itself showed

The saved run covers 162 production files and 1,129 functions, including
the research implementation. Parsing and bounded pair comparison completed.

| Signal | Observations | Interpretation after inspecting source |
| --- | --- | --- |
| Argument-preserving wrappers | 25 sites; 21 anonymous | Dominated by callback adapters, not evidence of waste |
| Identical switch vocabularies | One family, two sites, three labels | A real shared tallying responsibility worth reviewing |
| Near-matching switch vocabularies | Zero pairs among 10 eligible switches | No positive real-world evidence for H3 in this sample |

The four named wrapper sites are:

- `src/detectors/registry.ts:223`: `has` delegates to its bindings map.
- `src/discovery/classify.ts:65`: `isTypeScriptSource` names a regex predicate.
- `src/safeguards/budgets.ts:56`: `enforcedBy` is a configuration callback.
- `src/store/store.ts:228`: `insertRun` delegates to a transaction function.

All four have plausible architectural purposes. Of the 21 anonymous sites,
one is introduced by this research implementation itself. The thin SDK
functions with defaulted options are excluded by the conservative matching
rule. Removing defaults solely to increase detection would change semantics.

The repeated dispatch family is more actionable:

- `src/report/rollup.ts:56`, inside `accumulate`.
- `src/scoring/score.ts:63`, inside `scoreRun`.

Both dispatch on `disposition(entry)` using `counted`, `no-detector`, and
`not-applicable`. Both increment corresponding counters and add
`perCriterionScore(entry) ?? 0` for counted entries. This source inspection
supports a hypothesis of shared tallying logic, beyond the matching labels
alone. A change to disposition accounting could require coordinated edits.
It is not proof of a defect or a recommendation to refactor immediately:
both sites belong to the transitional legacy subsystem scheduled for removal.

The normal audit still reports **69/100**, with contributions **39/30/0**.
That stability is an observed result of this change, not an invariance claim
about adding research code generally.

## What the tests establish

The suite exercises layer addition, decision consolidation, case disagreement,
legitimate facade/callback controls, unrelated domains, lookup-table evasion,
local renaming, parentheses, comments, case ordering, source enumeration,
nested ownership, independent clean additions, source-set separation, malformed
files, comparison limits, and real filesystem/configuration integration.

The examples were authored alongside the probes, not preregistered or held
out. Several are syntax microfixtures, not executable software systems.
Passing them proves implementation behavior and exposes known confounders;
it does not prove expert agreement, reduced maintenance effort, or predictive
value. One repository, inspected by the author of the probes, cannot estimate
precision or recall. We did not measure developer time or downstream defects.

## Research decisions

1. **Reject raw forwarding count as a scoring candidate.** Retain located
   evidence for exploration. Investigate resolved chains and actual call-site
   variation, with explicit facade/transaction/callback controls.
2. **Advance repeated decisions to a maintenance-task study.** Verify whether
   matched sites implement the same responsibility, then observe the edits
   needed when that responsibility changes. Extend coverage to if-chains and
   lookup tables before claiming resilience to cosmetic rewrites.
3. **Keep case disagreement as an unvalidated hypothesis.** Obtain both real
   omissions and intentionally different subsets. Evaluate defaults and domain
   identity before making any consistency judgment.
4. **Keep all three outside scoring.** The next benchmark should compare
   predictive value against LOC, maximum CC, and existing duplication; split
   by repository and time, include independent reviewers, and report false
   positives and blind spots. This spike earns that experiment, not a weight
   in the sloppiness index.
