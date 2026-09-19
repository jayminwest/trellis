> Historical 0.1.0-provisional calibration record. The subsequent count-curve
> recalibration and current corpus checks are in [count calibration](count-calibration.md).

# Corpus validation record (trellis-e924, SPEC §14)

The fixed TypeScript corpus that validates the deterministic audit's score
behavior and performance, and the calibration record for the provisional
measurement/scoring constants. The corpus lives in [`corpus/`](../corpus)
(definition: `corpus/manifest.json`); the harness is
`scripts/validate-corpus.ts`; the paired expectations below are also
asserted continuously by `scripts/validate-corpus.test.ts`.

## Method

Every entry is audited through the same `auditWorkspace` core the CLI and
SDK fold — **no model judgments and no network access occur during an
audit**; corpus acquisition is the committed fixtures under
`corpus/fixtures/` (external acquisition would be a separate preparation
step and is not needed). Timing and peak memory are record metadata only
and never enter any measurement payload (SPEC §3.5). Each entry was
measured three times in a fresh child process (Bun startup included);
runtime is the median wall ms, memory is the max peak RSS (Linux VmHWM).

## Environment

| fact | value |
|---|---|
| corpus revision | `9ffe015` (trellis HEAD at the validation run; fixtures are committed, so the corpus revision is the repo revision) |
| analyzer / scoring / schema versions | 0.2.0 / 0.1.0-provisional / 1.0.0 |
| runtime | Bun 1.2.23, typescript 6.0.3, linux x64 |
| machine | Intel Xeon @ 2.20 GHz (2 vCPU container), 32 GiB |

## Corpus entries, observations, and budgets

Source sizes are the audited production coverage (test-set sizes in
parentheses where present). Budgets are the explicit targets chosen from
this measured corpus and enforced by the harness: fixture budgets are
~10× the worst observed median and ~2× the worst observed peak; the
trellis-self budget is ~2× the observed median and peak.

| entry | prod files | prod sloc | index | median ms | peak MiB | budget (ms / MiB) |
|---|---|---|---|---|---|---|
| clean-small | 2 (+1 test) | 10 | 0 | 83 | 266 | 2000 / 512 |
| clone-base | 3 | 43 | 16 | 102 | 274 | 2000 / 512 |
| clone-removed | 3 | 28 | 0 | 98 | 275 | 2000 / 512 |
| branch-base | 3 | 17 | 0 | 96 | 265 | 2000 / 512 |
| branch-grown | 3 | 44 | 26 | 96 | 273 | 2000 / 512 |
| acyclic | 4 | 15 | 0 | 85 | 272 | 2000 / 512 |
| cyclic | 4 | 16 | 12 | 94 | 240 | 2000 / 512 |
| dilution-base | 4 | 80 | 42 | 106 | 271 | 2000 / 512 |
| dilution-grown | 6 | 175 | 42 | 138 | 276 | 2000 / 512 |
| test-separation | 2 (+3 test) | 10 | 0 | 106 | 278 | 2000 / 512 |
| incomplete-parse | 2 | 4 | 100 (partial) | 68 | 269 | 2000 / 512 |
| trellis-self | 161 (+114 test) | 15,565 | 59 | 4,332 | 448 | 10,000 / 1024 |

Peak RSS is dominated by Bun + compiler startup (~240 MiB floor); the
self-audit of 275 files adds under 200 MiB. Runtime scales
sub-linearly with corpus size on this corpus; no performance fixes were
necessary, and no larger algorithm work is filed from this stage — the
duplication detector's bounded-feasibility budgets
(`DEFAULT_DUPLICATION_BUDGET`, 2,000,000 tokens / 100,000,000 comparisons
per source set) were confirmed, not changed: the largest observed source
set (trellis's own test set, ~135k tokens) keeps an order-of-magnitude
headroom.

## Paired refactors

Each pair's fixtures are byte-identical except for the one controlled
change. Intended metrics move predictably; every unrelated metric is
exactly unchanged (the harness asserts both directions and the equality
claims, so "explainable" here means "zero delta").

### clone-removal (index 16 → 0)

| metric | before | after | delta |
|---|---|---|---|
| duplication.density.production | 0.8837 | 0 | −0.8837 |
| duplication.groups.production | 1 | 0 | −1 |
| duplication.duplicated-lines.production | 38 | 0 | −38 |
| complexity.cc.max.production / erosion.eroded-count.production / import-cycle.groups | 5 / 0 / 0 | 5 / 0 / 0 | 0 |

### branch-growth (index 0 → 26)

| metric | before | after | delta |
|---|---|---|---|
| complexity.cc.max.production | 3 | 14 | +11 |
| erosion.eroded-count.production | 0 | 1 | +1 |
| erosion.eroded-share.production | 0 | 0.9604 | +0.9604 |
| duplication.groups / duplicated-lines / import-cycle.groups | 0 | 0 | 0 |

### cycle-introduction (index 0 → 12)

| metric | before | after | delta |
|---|---|---|---|
| import-cycle.density | 0 | 1 | +1 |
| import-cycle.groups | 0 | 1 | +1 |
| import-cycle.modules | 0 | 4 | +4 |
| complexity.cc.max / erosion.eroded-count / duplication.groups | 1 / 0 / 0 | 1 / 0 / 0 | 0 |

### dilution (index 42 → 42)

A large clean addition (95 sloc of varied branch-free helpers against an
80-sloc sloppy core) dilutes both densities while every absolute count
holds — and the index does not move at all. Both densities remain above
their saturation thresholds (0.15 duplication, 0.25 erosion), so their
normalized contributions also remain constant:

| metric | before | after | delta |
|---|---|---|---|
| duplication.density.production | 0.475 | 0.2171 | −0.2579 |
| erosion.eroded-share.production | 0.5943 | 0.4103 | −0.1840 |
| erosion.eroded-count.production | 1 | 1 | 0 |
| duplication.groups.production | 1 | 1 | 0 |
| duplication.duplicated-lines.production | 38 | 38 | 0 |
| complexity.cc.max.production | 12 | 12 | 0 |

## Explicit reviews (acceptance criteria)

- **Score dilution.** The dilution pair stays at 42 while both densities
  fall by ~40–55%. Both densities remain saturated, so this example alone
  does not prove that count terms prevent all score dilution. Count terms
  preserve their contribution as clean code is added; unsaturated density
  contributions can still decrease. Large-repo saturation and discrimination
  remain provisional calibration research (`trellis-831b`), not a resolved
  claim of size invariance.
- **Small-repo behavior.** `clean-small` (10 production sloc) scores 0
  with `complete` completeness; empty scopes produce `not-applicable`
  ratios with complete zero counts rather than fake zeros or errors, and
  no metric is absent. Tiny inputs do not produce pathological scores.
- **Test separation.** `test-separation` has clean production code and
  heavily cloned (density 0.535) and eroded (1 hotspot) tests: the index
  is exactly 0 while the test-set metrics are reported raw
  (`duplication.density.test = 0.535`, `erosion.eroded-count.test = 1`).
  Test debt is visible and never offsets or inflates production debt
  (SPEC §3.1).
- **Incomplete-analysis handling.** `incomplete-parse` (one syntax-error
  file) yields `completeness: incomplete`, a `partial` headline, and
  `incomplete` states with reasons on the affected complexity, erosion,
  duplication, and cycle metrics — and the index is published flagged at
  100 (incomplete dimensions score at full weight, never as zero debt,
  SPEC §7). Remaining analyzers' findings stay usable.

## Calibration decision (evidence → change)

**Minimum clone size: 50 → 100 normalized tokens**
(`DUPLICATION_MIN_TOKENS`; the 3-line minimum is unchanged). Evidence,
measured on the trellis checkout during this stage (self-audit at each
provisional candidate):

| min tokens | prod density | prod groups | index |
|---|---|---|---|
| 50 (provisional) | 0.1552 | 124 | 69 |
| 75 | 0.0828 | 46 | 62 |
| 100 (calibrated) | 0.0433 | 18 | 59 |
| 150 | 0.0264 | 8 | 50 |

At 50 tokens, 78 of the 124 production groups were 50–74 tokens and the
duplication dimension saturated (30/30 points) on a repo that passes a
100-token exact-match duplication gate — the tail was dominated by
idiomatic-structure matches (repeated branch blocks, registry-entry
shapes), exactly the noise the trellis-5a91 record assigned this stage to
control. At 100 tokens the surviving groups are true copy-paste (the
the measured revision’s source composition, ratchet-script clones,
self-similar generated tables), matching the 5a91 recall baseline at 100
tokens. Corpus construction reinforced this: every templated fixture
(repeated `if` blocks, generated function families) self-cloned under
normalization until hand-varied, regardless of the literals and
identifier names involved.

Because measurement semantics changed, the **analyzer version bumps
0.1.0 → 0.2.0** (pre-1.0 breaking change; stored 0.1.0 reports now
correctly fail §3.5 comparability). The scoring formula constants
(weights, saturations) are **unchanged**: the corpus showed the §7.1
thresholds producing explainable, monotonic, dilution-resistant behavior,
so the scoring version stays `0.1.0-provisional` and
`SCORING_FORMULA` is untouched. Test fixtures and expectations that
depended on the 50-token minimum were updated in the same change
(`src/metrics/duplication.test.ts`, `src/metrics/analyze-duplication.test.ts`,
`src/audit/audit.test.ts`, `src/report/audit-fixtures.ts`; clone fixtures
are now 105 tokens over 13 lines at CC 10, so they never leak hotspot
findings).

## Reproduce

```bash
bun run scripts/validate-corpus.ts        # exit 0 = corpus validates
```
