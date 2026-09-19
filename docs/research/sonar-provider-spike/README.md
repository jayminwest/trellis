# SonarJS provider spike

Production-source snapshots from the recorded commit are archived in Git;
checked-in fixture inputs and tool metadata remain available. Historical
production measurements below describe that commit, not the current tree.
Regenerate production outputs against the current source before using them
for new comparisons.

Decision: cognitive complexity adds useful *different* evidence about control-flow shape,
while the chosen bug rules add a separate category of located evidence. Neither warrants
changing the sloppiness score from this experiment. Resolve provider licensing evidence
before deciding on distribution/integration.

## Reproduce

This is an optional research harness. It does not change product dependencies or load the
target project's ESLint configuration. The runner uses Bun to import trellis's actual core
TypeScript functions. Run from the repository root:

```sh
mkdir -p /tmp/trellis-sonar-tools
cp docs/research/sonar-provider-spike/provider-package.json /tmp/trellis-sonar-tools/package.json
cp docs/research/sonar-provider-spike/provider-package-lock.json /tmp/trellis-sonar-tools/package-lock.json
npm ci --prefix /tmp/trellis-sonar-tools --ignore-scripts --no-audit --no-fund
bun docs/research/sonar-provider-spike/run.mjs
```

Installation needs registry access; subsequent analysis is local. The runner explicitly
writes `evidence.json` and `summary.json` beside itself. Set `TRELLIS_SONAR_TOOLS` to use
another existing provider directory. The lockfile pins transitive dependencies; direct
versions are ESLint 9.39.1, eslint-plugin-sonarjs 3.0.5, and parser 8.46.2. These are
experimental pins, not a recommendation to install old versions into a product.

## Scope and method

Base repository: `f3743bc0154ba032ef957a20dea678face1b3fa8`.
Trellis discovery classifies production files; the experiment selects those under
`src/` and `scripts/`, producing 162 files and 1,129 functions. Full paths and SHA-256
source hashes are in `evidence.json`; `summary.json` records the ordered corpus hash.
Research `.mjs` and fixture JSON do not enter the TS/TSX corpus. All source is read into
memory once and the same strings pass through both parsers.

Core `parseSource`, `collectFunctions`, and `measureFunctionComplexity` supply actual
per-function CC and nesting. Sonar's cognitive-complexity threshold is zero so positive
values become diagnostics; zero is inferred from absence. Located diagnostics map to the
smallest containing core function. Parse failures, missing/duplicate mappings and changed
diagnostic wording fail the experiment. This is a pinned experimental diagnostic adapter,
not a robust public metric API. Both providers report no parse errors on this corpus.

The ESLint Linter receives only the checked-in fixed configuration: the four selected
rules, TS parser, module mode, ECMAScript 2022 and JSX parsing. No project/tsconfig loading,
type-aware services, target plugins, inline configuration, automatic fixes, or target
commands are used. Core TS is 6.0.3; the provider resolves TS 5.9.3. New TS syntax could
produce parser differences; complete results here do not establish future compatibility.

Each run analyzes the same inputs twice and asserts deep equality of canonical evidence;
timing metadata is excluded. This demonstrates repeatability in one process, not universal
cross-runtime reproducibility. Runtime versions and descriptive timings are in the summary.

## Results

| Controlled implementation | Core CC by function | Sonar cognitive complexity |
| --- | --- | --- |
| Three nested conditions | 4 | 6 |
| Equivalent guard clauses | 4 | 3 |
| Same decisions extracted into helper | 3, 2 | 3, 1 |
| Ordinary four-case value decoder | 5 | 1 |
| Direct simple function | 1 | 0 |
| Same behavior behind two forwarding layers | 1, 1, 1 | 0, 0, 0 |

All six metric cases assert their exact expected arrays. The decoder illustrates legitimate
branching, not a ground-truth certification of design quality. Extraction lowers maximum
cognitive complexity from 6 to 3 and sum from 6 to 4 without removing a decision. Forwarding
layers remain invisible. Thus cognitive complexity helps identify nesting but does not solve
abstraction burden or score gaming.

Three syntax-only rule pairs add six more assertion cases:
`no-identical-expressions`, `no-identical-conditions`, and `no-element-overwrite` each
produce the expected one finding for a positive control and zero for its negative control.
They find **zero** problems in the production corpus. This is a smoke test of narrow rules,
not an estimate of precision/recall or a general correctness/quality verdict. Repeating a
condition, or overwriting a collection entry, can require contextual interpretation.

On production functions, cognitive complexity has maximum 23, median 1, p90 6; core CC
has maximum 19, median 2, p90 7 (nearest-rank percentiles). Their top-15 lists overlap at
five functions; ties sort by path and start location. Sonar's first three are `scan` in
`check-debt-markers.ts` (23 versus CC 19), `extractBacktickedPaths` in
`validate-agents-md.ts` (21 versus 14), and `scan` in `check-file-sizes.ts` (17 versus 15).
Full matched functions, locations, findings and rankings are retained. Rank differences
show a different emphasis, not proof one metric predicts maintenance better.

The recorded run took about 0.50 seconds for the first analysis pass and 0.33 seconds for
the repeated pass, including both analyzers and all fixtures but excluding installation,
discovery, input loading and output writing. These are descriptive timings on one machine.

## Adoption constraint observed in package contents

The installed package's `package.json` declares `LGPL-3.0-only`, while its `LICENSE` file
and cognitive-complexity implementation header identify `SONAR Source-Available License
v1.0`. This discrepancy is directly observable in the pinned distribution. This document
draws no legal conclusion; it prevents assuming that metadata establishes permissive reuse.
No provider source or binary is vendored into this repository.

## Next discriminating experiment

Compare cognitive complexity, CC, and nesting against measured comprehension/change tasks
on held-out TypeScript implementations. Expand bug controls to adversarial cases and human
triage before using finding counts. Keep behavior diagnostics separate from structural
burden, and preserve source/tool/config versions if a provider adapter is adopted.
