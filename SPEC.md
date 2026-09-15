# trellis — deterministic TypeScript sloppiness audit

> Product contract for the approved breaking pivot (mission `trellis-253e`,
> plan `pl-b2ea`). This document **replaces** the agent-readiness
> specification (rubric `0.2.0`, 9 categories / 90 criteria, LLM
> investigation). The readiness product is retired; its design record lives in
> git history (last shipped as trellis 0.1.0) and its stored history is
> preserved under the separation rules in §17.
>
> **Status discipline.** This spec describes the *target* product.
> Implementation is staged across the 23 issues of plan `pl-b2ea`; §17.3
> records what is built versus merely specified. Nothing in this document
> claims unbuilt behavior — where the tree and this spec disagree during the
> transition, the Seeds issue queue is the source of truth for what is done.

---

## 1. What trellis is

trellis is a **deterministic, offline, read-only audit tool** that measures
*sloppiness* in TypeScript codebases: structural debt that accumulates when
code grows faster than its shape — complex functions, eroding hotspots,
copy-paste duplication, and import cycles — plus a separate, non-scoring
inspection of the safeguard configuration (hooks and checks) that is supposed
to keep that debt out.

A run produces a **sloppiness index: 0–100, lower is better**, a set of
located findings, an explicit account of what was and was not analyzed, and a
separate safeguard evidence report. The same core runs locally, across a
fleet, and in CI, emitting one report artifact everywhere.

trellis executes **no model, no target code, and no project tooling**. It
parses source with a pinned TypeScript compiler API and inspects configuration
as data. The first audit of a repository requires neither Git nor credentials,
a database, network access, or installed project dependencies.

---

## 2. The pivot

The readiness product scored repositories 0–100% (higher-is-better) across a
90-criterion rubric, with ~22% of criteria graded from facts gathered by a
bounded LLM investigation pass (Pi in RPC mode). That product is retired
because its headline number mixed unlike signals, its agent pass made runs
nondeterministic per commit and unusable offline, and most of its value
collapsed into a small set of structural measurements that need no model at
all.

The pivot keeps the parts of the old design that were sound — one core behind
thin CLI/SDK surfaces, zod at every boundary, versioned scoring, honest
incompleteness, optional central history, canonical-config drift as a separate
capability — and replaces the measurement surface entirely:

| retired | replacement |
|---|---|
| 90-criterion readiness rubric, maturity levels 1–5 | versioned metric catalog + provisional sloppiness formula (§6, §8) |
| LLM investigation (Pi RPC) + deterministic grader | nothing — no-model execution is an invariant (§4) |
| per-language detector adapters (TS/Swift/Python) | one TypeScript/TSX analyzer; other languages reported as unsupported coverage (§5.4) |
| os-eco-native scoring overlays | removed; tooling presence grants no structural credit (§7.4) |
| mandatory SQLite run history | stateless by default; opt-in history (§13) |
| canonical-config drift (standards) | **kept**, as an independent capability that never feeds the index (§14) |

This is a **breaking change**: report shapes, CLI flags, configuration keys,
exit-policy dimensions, and stored run types all change. There is no numeric
bridge between readiness percentages and the sloppiness index (§17.1).

---

## 3. Goals & non-goals

### 3.1 Release scope

1. **Complexity** — per-function cyclomatic complexity, maximum nesting, and
   source size, with distributions and ranked hotspots (§6.1).
2. **Structural erosion** — a weighted mass model that concentrates on the
   functions where complexity and size compound (§6.2).
3. **Duplication** — deterministic clone detection producing stable clone
   groups, unique affected-line totals, and density (§6.3).
4. **Import cycles** — a workspace-aware dependency graph and complete
   strongly-connected-component cycle groups (§6.4).
5. **Basic hook/check inspection** — safeguard configuration (Git pre-commit
   hooks, supported agent hooks, lint/typecheck/test scripts, coverage/size/
   duplication budgets, CI references to checks) inspected as data, reported
   separately from the score (§7).

Supporting scope: TypeScript source discovery and classification, a shared
parse/function inventory, the versioned provisional scoring formula, report
rendering (terminal/JSON/Markdown), saved-report baseline comparison and
failure policies, opt-in SQLite history, and fleet aggregation.

### 3.2 Explicitly deferred (non-goals for this release)

- **Unused-code analysis** (dead exports, unreachable modules, unused
  dependencies).
- **Broader architecture rules** — layering/boundary enforcement, module
  ownership constraints, anything beyond cycle detection.
- **Project verification execution** — running builds, tests, linters, or
  hooks against the target. trellis inspects that checks are *wired*; it never
  executes them and never infers that they pass.
- **AI features** — any model use anywhere: no investigation, no
  LLM-assisted grading, no auto-remediation, no review summaries.
- **New language adapters** — Swift, Python, and every non-TypeScript
  language. Unsupported languages are *reported as coverage*, never silently
  scored (§5.4).
- Also deferred: web UI, hosted service, scheduling, automatic issue filing,
  standards-set expansion, per-repo committed scorecards, a Rust rewrite.

---

## 4. Invariants

These hold for every audit path — local, fleet, CI, CLI, or SDK. A change
that violates one is a bug regardless of test outcomes.

1. **No-model execution.** No audit path spawns or calls a model. There is no
   provider, model, or investigation configuration surface; legacy
   configuration that names one is rejected with an actionable error.
2. **Offline default.** The first audit of a repository requires neither Git
   nor credentials, a database, network access, or installed project
   dependencies. Uncommitted files and non-Git directories are analyzed as
   they exist; a dirty worktree is measured as-is.
3. **Determinism.** Same files + same audit configuration + same analyzer and
   scoring versions ⇒ equal measurement payload. Timestamps and timings are
   report metadata only — never equality or fingerprint inputs.
4. **Read-only.** An audit never mutates the target repository and never
   executes target code: no hooks, no scripts, no executable-config imports,
   no package installation.
5. **Honest incompleteness.** Unsupported languages, parse failures, and
   resource exhaustion surface as coverage and incompleteness — never as a
   silently clean result, and never as a fabricated pass.

---

## 5. Core concepts

### 5.1 Source sets and classification

Discovery classifies every file in the target tree into exactly one bucket:
**production**, **test**, **generated**, **vendored**, **declaration-only**,
**excluded**, or **unsupported** (a language trellis does not analyze).
Classification defaults are documented and overridable in the audit
configuration (§9.5). Rules that keep the inventory honest:

- Each included file belongs to exactly one scoring source set; nested
  packages are never double-counted.
- Package/source-set ownership comes from package manifests and workspace
  declarations — not from Git.
- Excluded, generated, vendored, and unsupported scopes are **reported**, not
  dropped: the report's coverage section shows what fraction of the tree the
  metrics actually describe.

### 5.2 Metrics, findings, and safeguards

- A **metric** is a versioned numeric measurement with a unit and, where
  meaningful, a numerator/denominator pair (e.g. duplicated lines / eligible
  lines). Metrics are raw facts; scoring (§8) is a separate, replaceable
  interpretation layer.
- A **finding** is a located observation: relative path, line range, kind,
  and message. Hotspots, clone groups, and cycle groups are findings as well
  as metric inputs, so a better aggregate number can never erase them.
- A **safeguard result** is configuration evidence (§7), reported alongside
  but **never inside** the sloppiness index.

### 5.3 Analysis states

Every analyzer, and the audit as a whole, resolves to one of:

- `complete` — the surface was fully analyzed.
- `incomplete` — part of the surface could not be analyzed (parse errors,
  resource exhaustion, unresolved imports); carries located diagnostics.
- `unsupported` — the surface is a language/form trellis does not analyze.
- `not-applicable` — the surface is genuinely absent (e.g. no functions in
  scope); produces documented finite values, not fake zeros presented as
  health.

### 5.4 Coverage: test coverage ≠ analysis completeness

The report keeps two coverage notions visibly separate:

- **Source coverage** — how the tree classified (§5.1): how much production
  vs test code exists, and how much was excluded, generated, or
  **unsupported**. Unsupported-language files appear here as unanalyzed
  surface; they are never counted as clean and never counted as sloppy.
- **Analysis completeness** — how much of the *analyzable* surface the
  analyzers actually processed. An incomplete audit publishes its partial
  findings with the incomplete state attached; it must not present an
  apparently complete headline score (§8.4).

### 5.5 Versions

Every report records three independent versions:

- **schema version** — the report/finding/measurement wire shape (§9).
- **analyzer version** — the measurement code + its pinned parser dependency.
- **scoring version** — the provisional formula (§8), semver'd by
  comparability impact: any change that can move an unchanged repo's index is
  at least a minor bump and is recorded in the calibration log.

Baseline comparison (§12) requires compatible versions and says so explicitly
when they are not.

---

## 6. Metric catalog (release scope)

The catalog is the versioned WHAT. Each metric lists its unit and source-set
scope. Production and test source sets are always measured and reported
**separately**; only production metrics feed the index (§8.3).

### 6.1 Complexity

Per function (declarations, expressions, arrows, methods, constructors,
accessors), from the shared parse inventory:

- `complexity.cyclomatic` — decision-point count per function. The branch
  rules are part of the analyzer contract: `if`/`else if`, loops, `case`
  clauses, `catch`, ternaries, `&&` / `||` / `??`, and optional chaining each
  count; **nested function bodies are attributed to themselves** and never
  double-counted in an enclosing function's total; overload signatures add no
  branches.
- `complexity.nesting.max` — maximum control-flow nesting depth per function.
- `size.sloc` — source lines excluding blank and comment-only lines, with a
  documented rule for multiline literals.
- Distributions (max, p90, mean) per source set, plus a ranked **hotspot**
  list: functions by erosion mass with exact relative paths and ranges.

Empty or function-free scopes yield documented finite values or an explicit
`not-applicable` state — never a divide-by-zero dressed up as zero.

### 6.2 Structural erosion

Erosion weights complexity by size so that long *and* branchy functions
dominate the index instead of averaging away:

```
mass(function)  = cyclomatic × sqrt(sloc)
erosion.mass    = Σ mass over the source set        # sums, never averages of averages
erosion.share   = mass from functions with CC > 10 / erosion.mass
```

Repository and package aggregation **sum masses**; averaging per-package
percentages is explicitly wrong because it lets small clean packages dilute a
concentrated hotspot. Size and nesting remain explanatory signals unless a
scoring version explicitly includes them.

### 6.3 Duplication

Deterministic, offline clone detection over the shared inventory. The exact
method — token-based implementation vs an embeddable analyzer, normalization
semantics, minimum clone size, overlap union, and the production/test
boundary rule — is fixed by a bounded feasibility decision (plan issue
`trellis-5a91`) and **recorded in this section** when it lands. The contract
the decision must satisfy:

- `duplication.groups` — stable clone groups with member ranges; ordering and
  group identifiers do not depend on filesystem enumeration order.
- `duplication.lines` — the **union** of affected source lines, counted once
  (overlapping clones never double-count).
- `duplication.density` — affected lines / eligible lines, with the
  denominator documented.
- No clones cross excluded or generated scopes; test-to-production matches
  follow the recorded boundary rule.
- Runtime and memory are bounded; exhaustion resolves to `incomplete` with
  diagnostics — never a silently clean result.

### 6.4 Import cycles

A dependency graph built from AST imports (comments and string contents
cannot forge edges) with TypeScript-aware resolution: tsconfig aliases,
extension mapping, package exports for supported resolution, and local
workspace packages. Edges are typed **runtime** vs **type-only**; re-exports
and literal dynamic imports are recorded; external packages are
distinguishable from unresolved local edges, and unresolved edges are
reported as graph-coverage incompleteness.

- `cycles.groups` — **complete** strongly connected components (size ≥ 2,
  plus self-imports per a documented rule), each with a stable identifier, a
  representative path, and member modules. First-cycle-only reporting is
  explicitly insufficient.
- `cycles.affected-density` — share of modules participating in any cycle.
- Package and repository views preserve cross-package cycles without
  double-counting. Whether runtime and type-only cycles score separately is a
  scoring-version decision, recorded with the formula (§8).

Cycle detection is the *only* graph policy in release scope — no layering or
boundary rules (§3.2).

### 6.5 What is deliberately not measured

Unused code, dependency freshness, test quality, runtime behavior,
performance, security posture, documentation quality, and anything requiring
execution or a model. Some were readiness-rubric criteria; they are out of
scope here, not re-scored elsewhere in the report.

---

## 7. Safeguard inspection (separate from the score)

Safeguards are the mechanisms supposed to keep sloppiness out: Git pre-commit
hooks, supported agent hooks, lint/typecheck/test scripts, coverage, file-size
and duplication budgets, and CI references to those checks. trellis inspects
them **as configuration** and reports the evidence **separately** from the
sloppiness index.

### 7.1 Evidence levels

Each safeguard resolves to one of four levels:

- `absent` — no configuration found.
- `configured` — configuration exists (a hook file, a script, a budget).
- `wired` — the configuration is structurally connected: the hook invokes the
  script, CI invokes the check, the budget is referenced by the command that
  enforces it.
- `unknown` — the construct is outside the small documented set of supported
  formats (unsupported shell constructs, executable configuration). Explicitly
  unverified, never guessed.

### 7.2 Rules

- **Execution is never inferred.** A `wired` check is evidence of wiring, not
  of passing. trellis never runs hooks or scripts to find out.
- Broken local references (a hook pointing at a missing script, CI invoking an
  absent command) produce **located findings**.
- Custom-named scripts are recognized through supported wiring, not by
  tool-name presence alone.
- Inspection covers a small, documented set of formats; everything else is
  `unknown`, not `absent`.

### 7.3 No offset

Safeguard evidence **cannot offset the index**. A repo with perfect hooks and
terrible code has a terrible index and a good safeguard report. Infrastructure
is context for the number, never an input to it (§8.3).

### 7.4 No tooling-presence credit

The presence of agent-instruction files (`AGENTS.md`, `CLAUDE.md`) or os-eco
tooling (seeds, mulch, canopy, plot) grants **no structural score credit and
no safeguard level**. The retired os-eco scoring overlays are not carried
over.

---

## 8. Scoring — the provisional sloppiness index

### 8.1 The number

The headline is a **sloppiness index from 0 to 100, lower is better**. It is
a weighted, normalized composite of the §6 production metrics — **not a
percentage of bad code**. An index of 40 does not mean 40% of the code is
bad; it means the weighted contributions sum to 40 on this formula's scale.
Every rendered score carries its direction ("lower is better") and the scoring
version, and no output may present the index as a percentage of anything.

### 8.2 Provisional and versioned

The initial formula is **provisional** pending calibration against a fixed
corpus (plan issue `trellis-e924`). It is pure over the raw metrics, fully
explicit — normalization thresholds, weights, and grouping are data in the
versioned scoring module, not lore — and recalibration bumps the scoring
version and its test expectations together. Default weights are identical
across repositories; policy budgets (§12.2) never mutate scoring weights.

### 8.3 Composition rules

- **Grouped signals.** Overlapping complexity/erosion/size signals are grouped
  so one defect is not accidentally penalized multiple times.
- **Production only.** Test-code metrics and safeguard results never offset
  production debt; they are reported in their own sections.
- **Counts and densities both retained.** Large clean additions can dilute a
  density but cannot erase hotspot findings or absolute masses — the report
  keeps both views so growth cannot launder debt.
- **Traceability.** Every score contribution decomposes to raw metrics and
  findings; the report renders that decomposition (§11).

### 8.4 Missing dimensions

If a required dimension is `incomplete`, the audit publishes its partial
results **without an apparently complete headline score**: the headline is
marked incomplete, the available contributions are shown, and the coverage
section explains what is missing. A clean-looking number over a
half-analyzed tree is the failure mode this rule exists to prevent.

---

## 9. Data contracts

Boundary schemas (zod) are versioned artifacts; the full contract lands with
plan issue `trellis-58a6`. The load-bearing shapes:

- **Measurement** — metric id, value, unit, optional numerator/denominator,
  source-set scope, analyzer version. Non-finite numbers and invalid ranges
  are rejected at the boundary.
- **Finding** — kind, relative path, line range, message. Paths are always
  repo-relative so reports are portable across checkouts.
- **Safeguard result** — safeguard id, evidence level (§7.1), evidence
  locations, findings.
- **Coverage** — per-classification file/line totals (§5.1) and per-analyzer
  completeness (§5.3), kept separate (§5.4).
- **Report** — schema/analyzer/scoring versions (§5.5), metrics, findings,
  safeguards, coverage, score contributions, and metadata. **The
  deterministic measurement payload excludes timestamps and timings**; those
  live in metadata and never participate in equality or fingerprinting.
- **Audit configuration** — declarative only: source exclusions and
  classification overrides, analysis policy (budgets, tolerances), output and
  persistence choices. **No executable hooks**: configuration is data, never
  code trellis runs.

Analysis states (§5.3) are part of every schema that can be partial; a
`complete` claim over partial data is a schema violation, not a rendering
choice.

---

## 10. Audit pipeline & architecture

One core pipeline, surface-agnostic, with persistence and policy evaluation
**outside** the measurement pass:

```
discover ──► parse ──► measure ──► inspect ──► score ──► report
(files →     (one shared   (§6 metrics   (§7        (§8 pure   (§9 artifact;
 classified   parse per     + findings    safeguard  formula)   rendering is
 inventory)   file, reused  per source    evidence)             a separate
              across all                          ↑             concern)
              analyzers)                          │
                       policy evaluation & history writes happen
                       after, over the finished artifact
```

- **Discovery** — TS/TSX inventory, package ownership via manifests and
  workspace declarations, classification (§5.1). No package installation, no
  repository script execution, no network lookup.
- **Parse** — a pinned `typescript` compiler-API dependency produces one
  syntax/function inventory per file, reused by every analyzer in the run.
  Parse errors become located `incomplete` diagnostics.
- **Measure / inspect / score** — §6, §7, §8 respectively.
- **Module discipline (api>cli>sdk, unchanged).** All behavior lives in the
  core modules under `src/`; `src/cli/` is a thin commander pass-through and
  `src/client/` a typed SDK whose types mirror the core. CLI and SDK audits
  exercise one code path, proven by deep-equal tests. There is no HTTP
  server.

---

## 11. Reports & rendering

One report artifact (§9), three renderings:

- **Terminal** — bounded and concise: headline index with direction and
  scoring version, completeness, top hotspots, cycle summary, safeguard
  levels, coverage.
- **JSON** — the full structured artifact: every metric, finding,
  contribution, and diagnostic. This is the baseline-comparison input (§12).
- **Markdown** — a useful bounded summary for pasting into issues/PRs.

Rendering rules: hotspots point to usable relative paths and line locations;
every score shows its direction and scoring version; no readiness levels,
maturity bands, legacy category labels, or agent-progress output appear; and
no rendering may frame the index as a percentage of bad code (§8.1).

---

## 12. Baseline comparison & failure policies

### 12.1 Comparing reports

Any two saved JSON reports can be compared — **no Git, no SQLite required**.
Comparison requires compatible schema/analyzer/scoring versions and
compatible source-scope semantics (same exclusions/classification); an
incompatible comparison is reported explicitly rather than silently computed.
Findings match conservatively across line shifts (a moved hotspot is the same
hotspot); metric deltas support documented absolute and relative tolerances.
The output classifies findings as new / resolved / persistent and metrics as
improved / regressed / unchanged.

### 12.2 Policies

Failure policies are independent, declarative checks over a report (or a
comparison): **metric budgets** (e.g. duplication density ≤ N), **score
regression** (index may not rise more than T vs baseline), and **new
findings** (no new cycle groups, no new hotspots above a mass threshold).
Policies return structured reasons. A better aggregate score can never
suppress an independently configured cycle or hotspot policy failure —
policies evaluate findings, not just the index.

### 12.3 Exit codes

Unchanged convention: `0` clean, `1` operational error (the audit could not
run), `2` policy failure (the report is still emitted; reasons go to stderr).
CI can therefore distinguish "trellis broke" from "the code broke the budget".

---

## 13. History (optional)

Audits are **stateless by default**: an audit with no persistence requested
creates no database and no hidden report files. Opt-in history uses
`bun:sqlite`:

- An append-only migration adds new-version run records **without touching
  legacy readiness runs** (§17.2).
- Legacy and new runs are visibly distinct record types and **never form a
  mixed score trend** — no query, view, or dashboard may chart readiness
  percentages and sloppiness indices on one axis.
- Trend queries select only version-compatible runs.
- Repository identity is robust to accidents: two unrelated directories with
  the same basename must not collide into one history.
- The retired investigation cache leaves no live coupling; new audits never
  require persistence to function.

---

## 14. Fleet & standards (optional consumers)

- **Fleet** — a targets file declares repositories; the fleet runner executes
  the same core audit per target and aggregates per-repository reports and
  policy results. Fleet results match independent core audits exactly; a
  failed target does not sink the run. Legacy targets configuration keys
  (readiness skips, investigation defaults, maturity thresholds) fail
  validation with actionable migration messages.
- **Standards / canonical-config drift** — the bundled canonical file set and
  drift comparison are **retained as an independent capability**. Drift
  results never contribute to the sloppiness index and never appear as score
  contributions; they render in their own section, exactly as safeguard
  evidence does. The standards set is not expanded in this release.

---

## 15. CLI & SDK surface

Target surface (transitional state in §17.3):

```
trellis audit <path> [--json|--md] [--out <file>] [--config <file>]
                     [--baseline <report.json>] [--fail-on ...] [--history <db>]
trellis compare <report-a.json> <report-b.json>   # artifact comparison, §12
trellis report [--repo <id>] [--history <db>]     # opt-in history views, §13
trellis fleet [--targets <file>]                  # §14
trellis standards                                 # canonical manifest + versions
trellis drift <path>                              # canonical drift only, §14
```

- Terminal output by default; `--json` / `--md` switch shape; `--out` writes
  the artifact. Exit codes per §12.3.
- Retired flags (`--rubric-version`, `--min-level`, provider/model and
  investigation-cache controls, readiness `--fail-on` dimensions) fail fast
  with an actionable message naming the replacement.
- The SDK (`src/client/`) exposes the same operations over the same core;
  request/response types mirror core types, and deep-equal tests prove one
  code path.

---

## 16. Local / fleet / CI parity

One core, one artifact, three contexts — identical results everywhere:

- **Local** — `trellis audit .` during refactoring; stateless unless history
  is requested.
- **Fleet** — the same audits orchestrated over a targets file (§14).
- **CI** — the same CLI in a workflow: pin the trellis version (which pins
  analyzer and scoring versions), archive the JSON report as a build
  artifact, and gate on exit codes — `2` is a policy failure to act on, `1`
  is an operational problem with the job itself. Scheduled and pre-release
  runs use the same commands; there is no hosted service and no CI-only code
  path.

Parity is enforced the way the old product enforced surface parity: one
implementation, deep-equal CLI/SDK tests, and fleet results that match
independent audits.

---

## 17. Legacy separation & transition

### 17.1 No numeric bridge

Readiness percentages/levels and the sloppiness index measure different
things on opposite scales. They are never converted, compared, averaged, or
trended together — in code, in storage, or in documentation. Migration
guidance is "start a new baseline", not "your L3 is now a 42".

### 17.2 Legacy artifacts

- **History** — existing SQLite readiness runs are preserved verbatim by an
  append-only migration and remain queryable as *legacy readiness history*
  (§13).
- **Rubric data** — the `0.2.0` rubric, detector bindings, and investigation
  subsystem are removed from execution and then from the tree by the early
  plan issues; the design record remains in git history (trellis 0.1.0).
- **Backlog** — open readiness-era issues are reconciled against this scope
  (keep / superseded / deferred) by plan issue `trellis-b12d`; nothing is
  silently reopened or deleted.

### 17.3 Staged implementation status

This spec is the contract; plan `pl-b2ea` (23 forward-chained issues under
mission `trellis-253e`) is the build order. As of this revision:

- **Built and current:** the legacy readiness implementation described by the
  previous revision of this document — it is being disconnected and removed
  first (agent execution off every public path, then subsystem deletion).
- **Specified, not yet built:** everything in §5–§16. Each section names (or
  is named by) the plan issue that lands it; the issue queue, not this
  document, is the live record of done-ness.

Sections of this spec that describe unbuilt behavior are written as contract
("must", "is") because they govern implementation review — not because the
behavior exists today.

---

## 18. Tech stack & conventions

Unchanged from the fleet standard, minus the model infrastructure:

- **Runtime:** Bun (runs TS directly, no build step for the CLI).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Parsing:** a **pinned `typescript` compiler-API dependency** — the single
  parse layer for all analyzers (§10).
- **Validation:** zod at every external boundary (§9).
- **Lint/format:** Biome, `--error-on-warnings`.
- **Storage:** `bun:sqlite`, opt-in history only (§13).
- **CLI:** commander; **logging:** pino (sensitive-key redaction retained).
- **No LLM provider, no Pi, no network calls** anywhere in the tree (§4.1).
- **Conventions:** kebab-case filenames, tab indent / 100-col, `.ts` import
  extensions, tests as `<name>.test.ts` beside the unit, golden fixtures under
  `__golden__/` for analyzer outputs, real temp dirs and real SQLite in tests
  (stub only true external boundaries).
- **Dogfood:** trellis audits itself under the new metrics, and the
  calibration corpus record (plan issue `trellis-e924`) explains its score.
  The retired "bands L4+ against itself" readiness acceptance is gone with
  the rubric.

---

## 19. Deferred / open

Everything in §3.2, plus: weighted per-metric tuning beyond the provisional
formula, a web dashboard over history, README score badges, scheduled drift
briefings, automatic remediation (fan-out fixes), and hosted/scheduled
execution. Each requires its own mission; none is implied by this contract.

---

## Appendix A — provenance

- **Superseded:** the agent-readiness specification (previous revision of
  this document; rubric `0.2.0`, 9 categories / 90 criteria, Pi-RPC
  investigation, canonical drift). Last shipped as trellis 0.1.0; retrievable
  from git history. Its own provenance (the `../notes` material and the
  de-branded day-job rubric) is recorded there.
- **Pivot decision:** mission `trellis-253e` and plan `pl-b2ea` — replace
  agent-readiness auditing with deterministic TypeScript sloppiness
  measurement: no model execution, offline Bun/TypeScript analysis, a
  versioned 0–100 lower-is-better index, separate safeguard results, and
  local/fleet/CI use through one core, with legacy history preserved
  separately.
- **Kept from the old design:** the api>cli>sdk core discipline, zod
  boundaries, versioned scoring with comparability rules, honest
  incompleteness (now §5.3/§5.4), central-but-optional state, and
  canonical-config drift as a separate capability.
