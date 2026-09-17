# Metrics and scoring

[Back to the README](../README.md)

## What the index measures

The headline number is a **weighted composite, not a percentage of bad
code** — 40 does not mean "40% of the code is bad." Every renderer shows the
direction and scoring version alongside it. Infrastructure cannot offset it:
safeguards, CI wiring, hooks, and test volume contribute nothing, and test
code is measured separately from production code.

### Metric catalog (SPEC §5)

| dimension | metrics |
| --- | --- |
| **Complexity** | per-function cyclomatic complexity (`complexity.cc.{p50,p90,max}.{production,test}`), max nesting depth, function counts, SLOC — with ranked `complexity.hotspot` findings |
| **Structural erosion** | function mass = `CC × √SLOC` (`erosion.mass.*`), share of mass in functions with CC > 10 (`erosion.eroded-share.*`) and their count (`erosion.eroded-count.*`) |
| **Duplication** | normalized-token clone groups (type-1 and identifier/literal-renamed type-2, ≥ 100 tokens and ≥ 3 lines), unique affected lines (`duplication.duplicated-lines.*`), density (`duplication.density.*`), group counts (`duplication.groups.*`) — under a declared token/match-work budget that fails `incomplete`, never silently clean |
| **Import cycles** | complete cyclic module groups over a workspace-aware resolved graph (`import-cycle.{groups,modules,density}`), runtime and type-only edges scored separately; unresolved-import coverage rides along (`graph.edges.*`) |
| **Safeguards** (non-scoring) | configuration evidence for Git hooks, agent hooks, lint/typecheck/test scripts, and quality budgets at four evidence levels: `absent` / `configured` / `structurally-wired` / `unknown`. Passing execution is never inferred. |

Only `production` and `test` source sets are scored, separately;
`generated`, `vendored`, and excluded scopes are reported as coverage, not
counted as clean. The index scores the **production** set only.

### The provisional formula (SPEC §7)

Scoring is a pure function of raw metrics — no configuration input, so policy
budgets can never move weights. Each dimension blends a density term with an
absolute-count term (50/50). Clean additions cannot dilute count contributions;
unsaturated density contributions can decrease:

| dimension | weight | density saturation · count log scale |
| --- | --- | --- |
| complexity-erosion | 0.50 | eroded share 0.25 · scale 20 |
| duplication | 0.30 | density 0.15 · scale 15 |
| import-cycle | 0.20 | density 0.10 · scale 5 |

Counts use `b = ln(1 + count / scale)` and `100 × b / (1 + b)`, with no
finite saturation. See [calibration evidence](count-calibration.md).

Every reported point traces to the raw metric ids and thresholds that
produced it. A required dimension that could not be fully analyzed scores at
full weight and flags the headline `partial` — an apparently complete score
is never published from partial analysis.

## Known limitations

- **TypeScript/TSX only.** Other languages are never analyzed; they surface
  as explicit `unsupported` coverage (a repo that is 60% Python shows 60%
  unsupported — not a clean bill).
- **Type-3 near clones are out of scope.** A divergence splits a clone into
  its maximal exact-normalized runs, each reported independently if above
  the 100-token minimum.
- **Configuration inspection, not execution.** trellis never runs the
  target's tests, builds, linters, or hooks and never claims they pass; a
  `structurally-wired` safeguard means "verifiably connected to an
  enforcement point," nothing more. Unsupported shell constructs stay
  `unknown`, never guessed.
- **Resolution is local-only.** Absent `node_modules` degrades import
  resolution to documented `unresolved` edges — never a network fetch — and
  incomplete graph coverage rolls cycle metrics up `incomplete`.
- **Provisional calibration and evidence gaps.** The count curve preserves
  sensitivity at large counts, but weights still need broader validation.
  Indirect budget references can remain only `configured` (`trellis-b412`). See the
  [release acceptance record](release-acceptance.md) for tested scope.
- **Explicitly not in this product:** unused-code analysis, architecture
  rules beyond cycle detection, any AI feature, a web UI, hosted/scheduled
  services, automatic remediation, and rewrites in other languages
  (SPEC §2, §15).
