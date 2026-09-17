# Count calibration (trellis-831b)

Recorded 2026-09-17 with analyzer 0.2.1, scoring 0.2.0-provisional,
Bun 1.3.14, TypeScript 6.0.3, macOS arm64. Lower scores mean less debt.

## Decision and invariants

Replace the three hard-capped count terms with a bounded logarithmic curve:
`b = ln(1 + count / scale)`; normalized count burden is `100 * b / (1 + b)`.
Scales retain the former thresholds (20 eroded functions, 15 clone groups,
5 cycle groups), preserving approximately the old slope near zero. Density
thresholds, dimension weights and 50/50 term shares are unchanged.

No finite count saturates mathematically. In floating-point arithmetic and
the rounded integer headline, sufficiently small changes can still disappear.
There is no intended 50-point floor for large repositories. Size alone never
contributes; persistent counts do, with diminishing marginal weight.

Each term is non-decreasing in its own raw metric. The count derivative is
`100 / ((scale + count) * (1 + b)^2)`, positive for nonnegative counts.
Positive weights and monotone rounding preserve this property in the index
when other metrics are held fixed. Adding clean code never changes a count
contribution. Unsaturated densities can decrease: SPEC §7 preserves count
weight, not a constant total score under arbitrary clean additions. This
limitation existed in the former formula and remains explicit.

Higher linear caps merely relocate the flat region. A smaller count share
retains the cutoff and weakens non-dilution. Per-kloc counts dilute with clean
additions. A simple `count/(count+scale)` curve approaches its ceiling too
quickly for the observed 92-times-cutoff clone count. The bounded log retains
headroom without fitting arbitrary new cutoffs to three repositories. It
remains provisional, not an empirically validated maintenance-cost model.

## Measured repository evidence

These are local workspace audits, not controlled equal-size experiments.
Trellis was measured during this change on base `e8a3459`; warren was on
`5333030b`, burrow on `c19c475`. Working trees are audited as present, so a
revision alone does not reproduce uncommitted source. Old/new below apply
both formulas to the **same current complete metrics**, isolating scoring
from analyzer changes.

| workspace | production files / sloc | eroded / clone / cycle counts | old saturated count terms | old index | new index |
|---|---|---|---|---|---|
| trellis | 165 / 15,873 | 25 / 18 / 0 | erosion, duplication | 58 | 36 |
| burrow | 126 / 18,416 | 55 / 24 / 0 | erosion, duplication | 70 | 51 |
| warren | 895 / 121,585 | 263 / 230 / 10 | all three | 85 | 70 |

| workspace | erosion share / duplication density / cycle density | new normalized count terms |
|---|---|---|
| trellis | 0.143032 / 0.040761 / 0 | 44.78 / 44.09 / 0 |
| burrow | 0.401066 / 0.047513 / 0 | 56.93 / 48.86 / 0 |
| warren | 0.304330 / 0.075059 / 0.027760 | 72.60 / 73.64 / 52.35 |

Trellis and burrow are similar in source size but have distinctly different
erosion share and counts; their new indices differ by 15 points. This is
structural-quality evidence, not an independent human quality label.

The issue's historical warren inputs (263 / 1,381 / 10 counts and
0.3041 / 0.2059 / 0.0278 densities) score 93 under the former complete
formula, 78 under the new one. Reducing only clone groups to 81 now scores
76, versus an unchanged 93 previously. Holding density constant deliberately
isolates the count gradient; a real removal may improve density as well.
The historical reported 100 also included graph degradation, which is a
separate effect fixed by trellis-f6b0.

## Controlled checks and fixed corpus

`src/scoring/count-calibration.test.ts` pins the historical sensitivity case,
strict count gradients through 100,000 counts, and unchanged count
contributions when densities drop by 1,000 times. Its synthetic equal-size
profiles are arithmetic controls, **not measured source repositories**:

| nominal kloc | cleaner counts (erosion / clones / cycles) | worse counts | cleaner / worse indices |
|---|---|---|---|
| 1 | 1 / 1 / 0 | 20 / 15 / 5 | 4 / 70 |
| 10 | 10 / 10 / 0 | 200 / 150 / 50 | 14 / 85 |
| 100 | 100 / 100 / 0 | 2,000 / 1,500 / 500 | 28 / 91 |

Cleaner densities are 0.01 / 0.01 / 0; worse densities are 0.3 / 0.2 / 0.1.
Every worse profile saturated all old count terms, irrespective of size.
No new count term saturates. These tests prevent reintroducing a hidden cap.

The existing fixed corpus passed all checks and paired-metric assertions
after recalibration: clone removal 16 → 0; branch growth 0 → 26; cycle
introduction 0 → 12; dilution 42 → 42; clean-small and test-separation 0;
incomplete-parse 100 and partial. One-run performance observations were
13–26 ms for fixtures and 423 ms for trellis, within every existing budget.
The dilution pair still has saturated densities; the separate unsaturated
unit tests establish count non-dilution without overstating total-score behavior.

## Duplication settings

Current detection requires **100 normalized tokens and 3 lines per member**.
Identifiers and literals normalize to placeholders; other token kinds retain
their identity. Comments/trivia and EOF are excluded. Import blocks and
type-only declarations are **included** if they meet the same minima.
Type-1 and type-2 clones count; type-3 near clones do not. Overlapping line
coverage is unioned for density; group counts follow normalized maximal runs
with contained groups removed. Production and tests are separate.

The historical issue used the earlier 50-token analyzer: its 20.6% density
is not the current detector's 7.51% warren density. Neither is directly
comparable to a jscpd gate without matching normalization, source exclusions,
minimum lines/tokens and grouping settings. Scoring did not change detection.

## Reproduction and compatibility

```sh
bun test src/scoring/count-calibration.test.ts src/scoring/sloppiness.test.ts
bun run scripts/validate-corpus.ts --runs 1 --out /tmp/corpus.json
bun run src/cli/main.ts audit ../warren --json --out /tmp/warren.json
bun run src/cli/main.ts audit ../burrow --json --out /tmp/burrow.json
# Update the affected fleet render snapshots only when accepting score changes:
bun test src/fleet/report.test.ts --update-snapshots
```

Scoring version changed from 0.1.0-provisional to 0.2.0-provisional. Analyzer
0.2.1 includes the asset-resolution fix. Existing compatibility checks reject
comparisons to older versions; regenerate baselines instead of interpreting
this recalibration as a code-quality improvement. Schema 1.0.0 is unchanged.
