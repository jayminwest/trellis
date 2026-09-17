# trellis — deterministic TypeScript sloppiness audit

> Spec. Codename **trellis** — the structure that keeps growth aligned.
> Created 2026-06-06 as an agent-readiness audit; **pivoted 2026-09** (plan
> `pl-b2ea`, feature `trellis-253e`) to a deterministic TypeScript sloppiness
> audit. This document is the authoritative product contract for the pivoted
> tool. The pivot is a **breaking change**: the 90-criterion readiness rubric,
> maturity levels, and the LLM investigation layer are retired, not
> reinterpreted. See §14 for the staged transition and what is actually built
> at any moment — nothing in this document claims unbuilt behavior.

---

## 1. What trellis is

trellis is a **deterministic, offline-by-default sloppiness audit** for
TypeScript/TSX workspaces. It parses source with the TypeScript compiler API
and measures structural debt — complexity, structural erosion, duplication,
and import cycles — plus a separate, non-scoring inspection of safeguard
configuration (hooks and check wiring). It emits a versioned report with a
**0–100 sloppiness index where lower is better**, raw metrics, score
contributions, ranked hotspots, and safeguard evidence.

Three invariants define the product:

1. **No-model execution.** No audit path — CLI, SDK, fleet, or CI — spawns an
   agent, calls a model, or consumes model-derived grading. There is no
   provider, prompt, or model configuration anywhere in the shipped surface.
   This is an invariant, not a default: a change that introduces one is a
   product bug.
2. **Offline and zero-footprint by default.** The first audit of a repo
   requires **neither Git nor credentials, a database, network access, or
   installed project dependencies**. It reads files as they exist on disk
   (dirty worktrees included), never runs the target's scripts or installs
   its packages, and writes nothing unless the operator explicitly requests
   an output file, a baseline, or history persistence.
3. **One core, every surface.** Local CLI runs, the programmatic SDK, fleet
   orchestration, and CI usage all exercise the same deterministic core with
   the same measurement, scoring, and policy code path. Parity is mechanical
   (deep-equal tests), not aspirational.

trellis answers one question: *how sloppy is this TypeScript tree, where
exactly, and is it getting worse?* It does not grade documentation, process,
or "agent-readiness," and it does not execute or verify the project's own
checks.

---

## 2. Goals & non-goals

### Release scope (goals)

- **Metric catalog (initial, §5):**
  - **Complexity** — per-function cyclomatic complexity, maximum nesting,
    source size, and distributions.
  - **Structural erosion** — weighted function mass and the share of mass in
    high-complexity functions.
  - **Duplication** — clone groups, unique affected lines, and density, under
    a bounded, deterministic feasibility decision.
  - **Import cycles** — complete cyclic module groups over a workspace-aware
    resolved dependency graph.
  - **Basic hook/check inspection (safeguards)** — configuration evidence for
    Git hooks, agent hooks, lint/typecheck/test scripts, and quality budgets,
    reported **separately** from the score (§5.5).
- **Versioned contracts** for measurements, findings, and audit
  configuration, with explicit analysis states (§6).
- **A provisional, versioned sloppiness formula** with traceable
  contributions (§7).
- **Baseline comparison and failure policies** over saved report artifacts,
  with the 0/1/2 exit-code convention (§9).
- **Optional history** in SQLite that preserves legacy readiness runs
  separately (§10); **optional fleet** aggregation and the pre-existing
  canonical-standards drift capability as independent consumers (§11).
- **CLI and SDK parity** over the single core (§12).

### Non-goals (explicitly deferred)

- **Unused-code analysis** (dead exports, unreachable modules, orphan files).
- **Broader architecture rules** (layering constraints, boundary enforcement,
  dependency-direction policies beyond cycle detection).
- **Project verification execution** — running the target's tests, builds,
  linters, or hooks. trellis inspects their *configuration*; it never
  executes them and never claims they pass.
- **AI features** of any kind — no model calls, agent passes, embeddings, or
  LLM-assisted grading, per the §1 invariant.
- **New language adapters** — TypeScript/TSX only. The retired Swift/Python
  detector adapters are not replaced; other languages are reported as
  unsupported coverage (§3.3), never analyzed.
- Also deferred: a web UI, automatic remediation / fix fan-out, hosted or
  scheduled services, README badges, and any rewrite in another language.

---

## 3. Core concepts

### 3.1 Source inventory & classification

Before measurement, trellis discovers the workspace's TS/TSX files and
assigns each to exactly one **source set**: `production`, `test`,
`generated`, `vendored`, or `declaration-only`. Ownership comes from package
manifests and workspace declarations (nested packages are never
double-counted), with documented defaults and explicit per-repo overrides in
the audit configuration (§6.5). Discovery works on uncommitted files and
non-Git directories, and never installs packages, runs repository scripts,
or touches the network.

Only `production` and `test` sets are scored, and they are scored
**separately** — test code never offsets production debt. `generated`,
`vendored`, and excluded scopes are reported as coverage, not counted as
clean.

### 3.2 Metrics, findings, and safeguards

- A **metric** is a deterministic numeric measurement with a unit and, where
  meaningful, a numerator/denominator pair (e.g. duplicated lines / analyzed
  lines). Raw metrics are reported separately from their score
  contributions.
- A **finding** is a located piece of evidence: a repo-relative path and a
  line range, plus a stable kind (hotspot function, clone group, cycle
  group, broken hook reference, …). Findings are ordered deterministically
  and are stable across filesystem enumeration order.
- A **safeguard result** is configuration evidence about a hook or check
  (§5.5). Safeguards are **not** metrics and contribute **nothing** to the
  sloppiness index.

### 3.3 Analysis states & unsupported-language coverage

Every measurement and every report carries an explicit state:

- `complete` — the measurement ran over its full intended scope.
- `incomplete` — part of the scope could not be analyzed (parse errors,
  unresolved imports, resource exhaustion). The report says what and where;
  an incomplete required dimension prevents publishing an apparently
  complete headline score (§7).
- `unsupported` — the source is outside the analyzed language set (non-TS/TSX
  files, whole non-TS packages). Unsupported surface is **coverage**, never
  cleanliness: a repo that is 60% Python shows 60% unsupported coverage, not
  a clean bill.
- `not-applicable` — the measurement is genuinely meaningless for the scope
  (e.g. complexity of a function-free declaration-only package). Documented
  per metric; never used to hide an analysis failure.

Test coverage (how much *test* source exists) and analysis completeness (how
much of the intended scope was actually measured) are distinct fields and are
never conflated.

### 3.4 The sloppiness index

The headline number is a **0–100 index where lower is better**, produced by
the provisional formula in §7.

- **It is not a percentage of bad code.** It is a weighted, normalized
  composite of structural signals; 40 does not mean "40% of the code is
  bad." Renderers must always display the direction ("lower is better") and
  the scoring version alongside the number, and must never present it as a
  percentage of anything.
- **Infrastructure cannot offset it.** Safeguards, CI wiring, hooks, test
  volume, and process artifacts contribute nothing to the index. A repo with
  perfect tooling and sloppy code scores sloppy; the safeguard report is
  where the tooling shows up. Likewise, test-source measurements are
  reported separately and never dilute production debt.
- **Counts and densities are both retained.** Large clean additions cannot
  erase hotspot findings: absolute counts (e.g. number of functions over the
  complexity threshold) and normalized densities are reported side by side,
  and findings persist regardless of ratio movement.
- **Missing required dimensions block the headline.** If a required metric is
  `incomplete`, the report says so and the index is either withheld or
  published explicitly flagged as partial — never silently complete-looking.

### 3.5 Versioning

Three versions travel with every report:

- **Analyzer version** — the trellis release that produced the measurements.
- **Scoring version** — the formula version (§7). The initial formula is
  **provisional** pending calibration against the fixed corpus (§14); any
  recalibration bumps the scoring version and its test expectations
  together.
- **Schema version** — the report/configuration contract version (§6).

Comparability rule: two reports are trend-comparable only when analyzer,
scoring, and configuration semantics are compatible; incompatible
comparisons are reported explicitly rather than silently computed (§9).

**Deterministic payload.** The measurement payload excludes timestamps,
durations, and machine identifiers from equality and fingerprint inputs:
same files + same configuration + same analyzer/scoring versions ⇒ equal
measurement payload. Timings may be recorded as metadata but never
participate in identity.

---

## 4. Architecture

Target module layout (the current tree is transitional — see §14):

```
trellis/
├─ src/
│  ├─ cli/                 # THIN commander entrypoints; delegate to core (§13.1)
│  ├─ client/              # typed SDK over the core; mirrors core types
│  ├─ config/              # declarative audit configuration: load + validate
│  ├─ discovery/           # TS/TSX source discovery → classified workspace inventory
│  ├─ syntax/              # shared parse layer (pinned TS compiler API) + function inventory
│  ├─ metrics/             # complexity, erosion, duplication, import cycles
│  ├─ safeguards/          # hook/check configuration inspection (non-scoring)
│  ├─ scoring/             # provisional sloppiness formula (pure)
│  ├─ report/              # report assembly + terminal / JSON / markdown renderers
│  ├─ compare/             # baseline comparison + failure policies
│  ├─ store/               # OPTIONAL SQLite history (append-only; legacy separation)
│  ├─ fleet/               # OPTIONAL targets orchestration over the same core
│  ├─ standards/           # canonical-config drift (separate capability, §11)
│  └─ index.ts             # public lib entry — VERSION constant only
└─ ...
```

The pipeline is one-directional:

```
discover → parse (shared inventory) → measure (metrics + safeguards)
        → score (pure, provisional formula) → assemble report
        → [render] [compare vs baseline + policy] [persist, if asked]
```

Persistence and policy evaluation live **outside** the measurement pass; a
measurement never touches the database or the network.

The **api>cli>sdk discipline** (§13.1) is unchanged: all behavior in core
modules; `src/cli/` and `src/client/` are thin pass-throughs exercising one
code path.

---

## 5. The metric catalog (release scope)

### 5.1 Complexity

Per-function measurements over the shared syntax inventory:

- **Cyclomatic complexity (CC)** per function, with an exact, documented
  definition of which AST decisions count: `if`/`else if`, `for`/`for-in`/
  `for-of`/`while`/`do`, `case` clauses, `catch`, logical operators
  (`&&`/`||`/`??`), conditional expressions, and optional chaining. Nested
  functions are attributed to themselves, never folded into the parent's
  branch totals; overload signatures are not bodies.
- **Maximum nesting depth** per function.
- **Source size** per function and per file (SLOC, with documented handling
  of multiline literals and comment-only lines).
- **Distributions** per package and repo (e.g. p50/p90/max CC), plus ranked
  **hotspots** with exact relative paths and line ranges.

Size and nesting are explanatory signals unless the scoring formula
explicitly includes them (§7). Empty or function-free scopes produce
documented finite values or `not-applicable`, never crashes or silent zeros.

### 5.2 Structural erosion

Erosion weights complexity by size so a huge tangled function outranks a tiny
tangled one:

- **Function mass** = `CC × sqrt(SLOC)`.
- **Eroded mass share** = the share of total mass belonging to functions with
  `CC > 10`.
- Aggregation from functions → packages → repo uses **summed masses**, never
  averages of package percentages (a big package's erosion must not be
  diluted by averaging it against tiny ones).

### 5.3 Duplication

Clone detection over the shared inventory, under a **bounded, deterministic
feasibility decision**: before running, trellis decides from corpus size
whether the analysis fits declared time/memory budgets; if not, the metric is
`incomplete` with the reason — resource limits never silently return a clean
result.

- **Clone groups**: stable group identifiers, member ranges, and copy counts;
  deterministic ordering independent of filesystem enumeration.
- **Unique affected lines**: the numerator counts the *union* of duplicated
  source lines once (overlapping clones are not double-counted), over a
  documented compatible denominator, yielding a duplication **density**.
- **Scope discipline**: no clones cross excluded/generated scopes;
  test-to-production matches follow the documented contract (test and
  production duplication are reported separately).

**Decision (trellis-5a91, 2026-09-16): a small normalized-token
detector over the shared parse, built and owned by trellis.** The evaluation
compared a spike of this approach against the two embeddable forms of the
existing deterministic analyzer jscpd — 4.3.0 (JS library API) and 5.2.1
(Rust engine, prebuilt platform binaries) — on fixed local fixtures and two
declared corpora (record below). Both jscpd forms were rejected: 5.2.1
embeds only as a subprocess around an opaque platform binary (8
optionalDependency platform packages), reports clone *pairs* rather than
groups, is type-1 only by default, runs threaded with a timestamped payload,
and auto-discovers config from scanned ancestors — an external process
boundary inside the measurement path, against the §8 “local parsing and
arithmetic” invariant. 4.3.0 is the unmaintained JS line: it fails to import
under Bun (reproduced: `colors` CJS/ESM interop), pulls 118 transitive
packages (~20 MB), is type-1 only, and stamps `foundDate` into clone
payloads. The own implementation adds **zero runtime dependencies** (the
pinned `typescript` is already ours), reuses the one shared parse (§13), and
is the only candidate that natively provides the required semantics below —
clone groups, overlap-union line accounting, per-source-set separation, and
budget-exhaustion `incomplete` states.

Semantics fixed by this decision:

- **Token stream**: the leaf tokens of the shared `ts.SourceFile` in document
  order (comments and trivia never appear). A raw scanner loop is not used:
  it mis-tokenizes template literals without manual re-scan state
  (reproduced); the AST walk is correct by construction and needs no second
  parse.
- **Exact/normalized semantics**: every identifier maps to one placeholder
  and every literal (string, numeric, bigint, regex, template part) maps to
  one placeholder; all other tokens contribute their `SyntaxKind`. This
  detects exact (type-1) and identifier/literal-renamed (type-2) clones.
  Near clones (type-3) are **out of scope**: a divergence splits a match into
  maximal exact-normalized runs, each reported independently if above the
  minimum size. (jscpd 5’s `--similarity` AST mode is the noted direction if
  type-3 is ever revisited.)
- **Minimum clone size** (provisional; the corpus stage, trellis-e924, owns
  final calibration): **50 normalized tokens and 3 lines**, both required.
- **Grouping**: a clone group is the set of ranges sharing one identical
  normalized token sequence (content identity), with at least two members
  after dropping same-file token-contained members; there is no transitive
  pairwise merging. Within-file repeats count as clones.
- **Ranges** are token-exact maximal runs; a reported line range may include
  a partial boundary line (both jscpd engines exhibit the same overhang).
- **Overlap union**: the numerator is the union of code-classified lines
  (§5.1 line rules) covered by any member range, counted once per file —
  overlapping or nested groups never double-count; the denominator is the
  scope’s total code-classified lines, making the density a ratio of
  compatible quantities.
- **Production/test boundary**: detection runs **per source set** — token
  streams are never matched across sets, so production and test duplication
  are measured separately (§3.1); `generated`, `vendored`,
  `declaration-only`, and excluded files are never tokenized.
- **Bounded feasibility**: declared token-count and match-work budgets are
  checked as the analysis runs; on exhaustion the metric is `incomplete`
  with the reason — never a silent clean result. Landed with the
  implementation (trellis-6e4c; the corpus stage tunes them): a **token
  budget** of 2,000,000 normalized tokens per source set and a
  **match-work budget** of 100,000,000 token comparisons per source set
  (`DEFAULT_DUPLICATION_BUDGET` in `src/metrics/duplication.ts`).

Evaluation record (evidence; directional measurements, not benchmarks):

- **Fixtures**: six hand-authored TS cases with known outcomes — exact copy,
  identifier/literal rename, overlapping multi-file regions, four-way
  multi-copy, below-threshold idiom, and a near clone with two changed
  lines. At 50 tokens the spike produced exactly the semantics above (the
  renamed clone detected; the below-threshold idiom silent; the near clone
  reported as its maximal shared run). Both jscpd engines matched the
  type-1 outcomes but missed the renamed clone entirely (jscpd 5 finds it
  only in `--similarity` mode).
- **Corpora**: C1 = trellis `src/` @ `853348b` (185 TS files including
  tests; 22,854 physical lines, 19,847 token-covered code lines, 131,994
  leaf tokens). C2 = C1 replicated 4× (740 files, 91,416 physical lines) as
  a deterministic high-multiplicity stress corpus.
- **Environment**: Linux x86_64 container (kernel 6.12), 2 vCPU Intel Xeon
  @ 2.20 GHz, 32 GB RAM; Bun 1.2.23; Node 22.23.2; typescript 6.0.3; jscpd
  4.3.0 / 5.2.1 from npm. Timings are median wall ms of 3 runs (1 run for
  C2 spike/jscpd-4), process startup included; memory is peak RSS (VmHWM).

| engine | C1 @ 50 tok | C1 @ 100 tok | C2 @ 50 tok |
|---|---|---|---|
| spike (naive, Bun) | 9.1 s / 360 MB | 7.5 s / 338 MB | 70.5 s / 493 MB |
| jscpd 4.3.0 API (Node) | 11.3 s / 180 MB | — | 26.5 s / 303 MB |
| jscpd 5.2.1 CLI (Rust) | 0.9 s / 47 MB | ~0.9 s / 47 MB | 1.6 s / 47 MB |

- **Recall comparison** at 100 tokens on C1: spike 506 content groups /
  2,909 union lines (14.7% of code lines) vs. jscpd 5: 13 pairs / 270 lines
  (1.2%). Spot-checks confirmed the spike’s extra recall is dominated by
  true renamed copy-paste (e.g. the `runCli` test helper cloned across four
  test files) that exact-token engines cannot see, plus idiomatic-structure
  matches that threshold calibration (trellis-e924) must control.
- **Limitations**: the spike is deliberately naive (per-bucket pairwise
  extension) — its numbers are a floor, and known optimizations (window
  index built once, occurrence-deduped buckets, capped bucket enumeration)
  precede the budget guard; even so, naive cost at real-repo scale is in
  the same class as the mature JS engine. Type-3 near clones are deferred.
  Timings come from one container on one day; they justify feasibility, not
  speed claims.

### 5.4 Import cycles

- **Graph construction**: imports are taken from the AST (comments and string
  contents cannot forge imports) and resolved with TypeScript resolution
  appropriate to tsconfig aliases and local workspace packages. Re-exports,
  literal dynamic imports, and unresolved imports are recorded; external
  packages are distinguishable from unresolved *local* edges, and unresolved
  coverage accompanies the results. Resolution uses local files and
  configuration only — absent `node_modules` degrades to documented
  unresolved edges, never to a network fetch.
  *(Landed, trellis-d214: `src/metrics/graph-*.ts` + `analyze-graph.ts`.
  The governing tsconfig is the nearest `tsconfig.json` walking up from the
  importing file; undeclared `moduleResolution` defaults to `bundler`, and
  `paths` without `baseUrl` resolve against the config's directory.
  Workspace packages resolve by manifest name through `exports` (string or
  one condition level, `import`→`require`→`default`→`types`, single `*`
  wildcard; an `exports`-bearing package encapsulates unlisted subpaths),
  then `main`, `types`, `index`. Externals are recorded by name and never
  resolved into — `node_modules` is never consulted, so absent dependencies
  change nothing; workspace entries pointing at absent build outputs surface
  as documented `unresolved` edges. Resolution targets outside the
  classified scope are `out-of-scope` edges, not nodes.)*
- **Edges are typed**: runtime vs. type-only edges retain their identity;
  whether they are scored separately is fixed by the (versioned) graph
  policy. *(Landed, trellis-d214: `GRAPH_POLICY` version `1.0.0` in
  `src/metrics/graph-types.ts` — type-only edges retained-distinct,
  literal-only dynamic imports, self-edges retained, externals
  recorded-never-resolved.)*
- **Cycle measurement**: strongly connected components expose **complete
  cyclic module groups** (not first-cycle-only), with affected-module
  density and representative paths. Group identifiers and representative
  paths are stable across enumeration order. Package and repo views preserve
  cross-package cycles without double-counting. Disjoint, overlapping,
  acyclic, and self-import cases have specified, tested outcomes.
  *(Landed, trellis-cbde: `src/metrics/cycles.ts` + `analyze-cycles.ts`
  under `CYCLE_POLICY` version `1.0.0`. Runtime and type-only edges form
  two separate subgraphs — a pair linked runtime one way and type-only the
  other is not a cycle in either — and the two classes are **scored
  separately**; a group cyclic in both appears once per class. A retained
  self-edge is a size-1 group with representative path `[p, p]`. Ids
  `cycle-<n>` follow (smallest member, class) order; the representative
  path is the shortest cycle from the smallest member over sorted
  adjacency. Cross-package groups keep one id across per-package views
  while module counts stay per-package, so the repo-level affected-module
  union never double-counts. Emits `import-cycle.groups` /
  `import-cycle.modules` / `import-cycle.density` and one located
  `import-cycle` finding per group; incomplete graph coverage (unresolved
  edges, parse diagnostics) rolls every cycle metric up `incomplete` with
  the graph's reasons and a machine-readable `unresolvedEdges` count.)*

### 5.5 Safeguards (hook/check inspection — separate from the score)

Safeguards inspect **configuration**, never execution, over a small
documented set of supported formats:

- Git pre-commit hooks; supported agent hook surfaces.
- lint / typecheck / test scripts in package manifests, including custom
  named scripts recognized through supported wiring (not named-tool presence
  alone).
- Coverage / file-size / duplication budgets and references to the checks
  that enforce them.

Each safeguard is reported at one of four **evidence levels**:

| level | meaning |
|---|---|
| `absent` | no configuration surface found |
| `configured` | configuration exists |
| `structurally-wired` | configuration is verifiably connected to an enforcement point (e.g. a CI step invoking the check script) |
| `unknown` | the surface uses unsupported constructs (arbitrary shell, executable config) — explicitly unverified |

Rules:

- **Passing execution is never inferred.** trellis reports that a check is
  wired, not that it succeeds.
- Broken local hook/check references produce **located findings** (path +
  range).
- Unsupported shell constructs or executable configuration remain
  `unknown` — never guessed.
- **No score credit.** Safeguard results do not enter the sloppiness index in
  either direction, and no use of seeds/mulch/canopy or the presence of
  agent-instruction files grants any structural credit.

---

## 6. Data shapes (versioned contracts)

All contracts are zod-validated at every boundary and carry the §3.5 schema
version. Schemas reject invalid ranges, non-finite numbers, missing required
version data, and misleading `complete` states.

### 6.1 Metric value

```jsonc
{
  "id": "duplication.density",
  "state": "complete",              // complete | incomplete | unsupported | not-applicable
  "value": 0.031,                   // finite number, unit per metric catalog
  "unit": "ratio",
  "numerator": 412,                 // optional raw pair (unique duplicated lines)
  "denominator": 13280,             //   (analyzed lines)
  "detail": { /* per-metric extras: distributions, group counts, ... */ }
}
```

### 6.2 Finding

```jsonc
{
  "kind": "complexity.hotspot",     // stable, versioned kind
  "path": "src/report/build.ts",    // repo-relative
  "range": { "start": { "line": 41 }, "end": { "line": 128 } },
  "summary": "CC 23, mass 214",
  "facts": { "cc": 23, "mass": 214 }
}
```

### 6.3 Safeguard result

```jsonc
{
  "id": "pre-commit-hook",
  "evidence": "structurally-wired", // absent | configured | structurally-wired | unknown
  "locations": [ { "path": "scripts/hooks/pre-commit" } ],
  "notes": "invoked via core.hooksPath; check:all referenced from CI"
}
```

### 6.4 Report

```jsonc
{
  "schemaVersion": "1.0.0",
  "analyzerVersion": "0.2.0",
  "scoringVersion": "0.1.0-provisional",
  "repo": { "root": "/abs/path", "identity": "…" },
  "sourceCoverage": {
    "production": { "files": 210, "sloc": 13280 },
    "test": { "files": 96, "sloc": 5100 },
    "generated": { "files": 4 },
    "unsupported": { "files": 30, "note": "non-TS sources, not analyzed" }
  },
  "completeness": "complete",       // rolled up from metric states
  "metrics": { /* §6.1 by id, raw values separate from contributions */ },
  "score": {
    "index": 27,                    // 0–100, LOWER IS BETTER — not a percentage
    "direction": "lower-is-better",
    "partial": false,               // true when a required dimension is incomplete
    "contributions": [ /* per-dimension points, traceable to raw metrics */ ]
  },
  "findings": [ /* §6.2, deterministically ordered */ ],
  "safeguards": [ /* §6.3 — separate; never folded into score */ ]
}
```

The deterministic measurement payload (everything except run metadata such
as `auditedAt` and durations) is equality-stable per §3.5.

### 6.5 Audit configuration (declarative)

Per-repo configuration is data, not code — **no executable hooks**:

```yaml
# trellis.yaml (optional; sensible defaults without it)
source:
  exclude: ["src/generated/**"]        # additions to documented defaults
  classify:
    "scripts/tools/**": "test"          # explicit source-set overrides
policy:                                 # failure policy only — never mutates scoring weights
  maxIndex: 40
  regression:                           # score regression vs a baseline report (§9)
    maxIncrease: 2                      # absolute tolerance, in index points
    maxIncreasePercent: 10              # relative tolerance, % of the baseline index
  budgets:
    duplication.density: { max: 0.05 }
  failOnNew: [import-cycle, complexity.hotspot]
```

Policy budgets gate the run; they never silently change how the index is
computed (§7).

---

## 7. Scoring — the provisional formula

Scoring is a **pure function** of structural raw metrics. The initial formula
is **provisional** (`scoringVersion: 0.1.0-provisional`) pending calibration
against the fixed corpus (§14); normalization thresholds and weights are
documented in §7.1 (landed with `trellis-00d5`) and recalibrated only with a
scoring-version bump.

Formula rules (fixed now):

- **Dimensions**: complexity/erosion, duplication, import cycles. Overlapping
  signals (complexity, erosion, size) are **grouped** so a repo is not
  penalized multiple times for the same underlying tangle.
- **Normalization**: each dimension normalizes its raw metric against
  documented thresholds into 0–100 points; the index is the documented
  weighted sum, clamped to 0–100 with stable rounding. Lower is better, and
  the function is monotonic: no code change that worsens a raw metric may
  improve the index.
- **Contributions**: every point is traceable — the report lists each
  dimension's contribution alongside the raw metrics and findings that
  produced it.
- **Missing-analysis policy**: a required dimension that is `incomplete`
  blocks or explicitly flags the headline index (§3.4); it is never treated
  as zero debt.
- **Aggregation**: package scores roll up from summed masses/counts, not
  averages of package ratios.
- **No offsets**: safeguards, test code, and infrastructure contribute
  nothing (§3.4). Policy budgets (§6.5) gate pass/fail; they do not mutate
  weights.

### 7.1 The provisional constants

*(Landed, trellis-00d5: `src/scoring/formula.ts` pins every constant below
in `SCORING_FORMULA` under `SCORING_VERSION`; `src/scoring/sloppiness.ts`
implements `scoreSloppiness(metrics)` over the contract `MetricValue`s. The
function takes **no configuration input**, so policy budgets can never
mutate the weights — the strict audit-config schema rejects scoring keys
outright.)*

The index scores the **production** source set only; test-set metrics are
reported raw (§3.1) and never offset production debt. Import cycles are
repo-level by construction.

| dimension | weight | terms (raw value ⇒ saturation ⇒ 100) |
|---|---|---|
| `complexity-erosion` | 0.50 | `erosion.eroded-share.production` @ 0.25; `erosion.eroded-count.production` @ 20 |
| `duplication` | 0.30 | `duplication.density.production` @ 0.15; `duplication.groups.production` @ 15 |
| `import-cycle` | 0.20 | `import-cycle.density` @ 0.10; `import-cycle.groups` @ 5 |

- Each term normalizes linearly: `100 × min(1, value / saturation)`. Every
  dimension blends an **absolute-count term** beside its **density term**
  (even 50/50), so large clean additions can never dilute counts or erase
  hotspot weight — counts and densities are both retained (§3.4).
- Grouping complexity, erosion, and size into one `complexity-erosion`
  dimension keeps the same underlying tangle from being penalized multiple
  times.
- `index = clamp(⌊Σ weight × dimension + 0.5⌋, 0, 100)` — round-half-up
  over IEEE-754 doubles, stable across runs and platforms. Each reported
  contribution is the **largest-remainder integer apportionment** of its
  exact weighted points (ties by dimension id), so contributions always sum
  exactly to the index. Every point traces to the raw metric ids, values,
  and thresholds in the dimension's explanation.
- **Missing analysis is never zero debt**: a dimension whose required
  metrics are `incomplete` (or absent) scores at its full weight and the
  headline is flagged `partial` (§3.4) — an apparently complete score is
  never published from partial analysis. A `not-applicable` ratio with
  complete zero counts is a genuinely empty scope and scores 0; the
  companion count metric independently confirms zero debt.
- **Aggregation**: the formula consumes only summed-mass repo metrics
  (§5.2 numerator/denominator sums). Per-package ratios in metric `detail`
  are explanatory and are never averaged into the index.

---

## 8. Offline, no-model, and zero-footprint invariants

An audit run, end to end:

- **No model.** No agent process, provider SDK, prompt, or API key is
  involved in any code path. There is nothing to configure because there is
  nothing to connect.
- **No network.** All analysis is local parsing and arithmetic. Tool
  acquisition (if any) is a separate preparation step, never part of an
  audit.
- **No Git required.** Dirty worktrees and uncommitted files are analyzed as
  they exist; non-Git directories audit fine. Commit identity, when present,
  is metadata only.
- **No credentials.** Nothing to authenticate against.
- **No database by default.** An audit without explicit persistence flags is
  stateless: it creates no hidden database or report files. History (§10) is
  opt-in.
- **No installed project dependencies.** trellis never runs `install`, never
  executes the target's scripts, and never imports its executable
  configuration. Absent `node_modules` degrades import resolution to
  documented unresolved edges (§5.4).

---

## 9. Baseline comparison & failure policies

- **Artifact comparison**: two saved JSON reports compare directly — no Git,
  no SQLite. Comparison requires compatible analyzer/scoring/configuration/
  source-scope semantics; incompatible pairs are reported explicitly.
- **Finding matching is conservative**: findings match by kind + path with
  tolerance for line shifts; ambiguous matches are reported as
  new/resolved pairs rather than silently paired. Reports classify findings
  as new, resolved, or persistent.
- **Tolerances**: absolute vs. relative tolerances are documented per policy
  knob; score regression uses the configured tolerance, not zero.
- **Policies are independent**: metric budgets, score-regression, and
  new-finding policies (e.g. "no new import cycles", "no new hotspots") are
  evaluated independently — a better aggregate index cannot suppress a
  configured cycle or hotspot failure. Policies return structured reasons.
- **Exit codes** (unchanged convention): `0` clean; `2` when a policy trips
  (the report is still emitted to stdout; reasons go to stderr); `1` on
  operational error (the audit could not run). Policy failure and
  operational failure are always distinguishable.

*(Landed, trellis-942c: `src/compare/` — `load.ts` reads a saved JSON report
and re-validates it against the §6.4 contract (no Git, no SQLite; failures
are operational errors, never policy failures). `compare.ts` compares two
validated artifacts: comparability is refused explicitly on schema/analyzer/
scoring version, metric-catalog, or supplied-configuration mismatches, while
unverifiable configuration and changed source scope are reported as caveats;
finding matching pairs by kind + path with unlimited line-shift tolerance
inside a 1:1 group and reports ambiguous n:m groups as resolved + new pairs.
`policy.ts` evaluates max-index, metric budgets, score regression (absolute
`maxIncrease` points / relative `maxIncreasePercent` of the baseline index,
each documented per knob), and `failOnNew` kinds independently — each returns
structured coded reasons, a better index cannot suppress a cycle/hotspot
failure, and baseline-dependent policies skip on an absent baseline but fail
closed on an incompatible one. CLI (`trellis compare`, `--baseline`) and SDK
wiring lands with trellis-9a88.)*

---

## 10. History (optional) & legacy separation

- Persistence is **opt-in** (`--history` / SDK option); the default audit is
  stateless (§8).
- When enabled, runs append to a local SQLite database (`bun:sqlite`,
  append-only migrations). Repository identity avoids accidental collisions
  between unrelated directories that share a basename.
- **Legacy separation.** Databases from the readiness product keep their
  rows: legacy runs are preserved as *legacy readiness history*, visibly
  distinct in every view, and their numeric values (0–100% readiness, levels)
  are **never** compared with, averaged into, or trended against sloppiness
  indices. There is no migration of legacy scores into the new scale — the
  two products measure different things.
- Trend queries select only compatible runs (§3.5).

---

## 11. Fleet & standards (optional consumers)

- **Fleet** (`targets.yaml`) orchestrates the same core over multiple repos
  and aggregates results; per-repo findings and completeness are preserved,
  and fleet results match independent core audits. Legacy targets
  configuration (readiness skips, investigation defaults, maturity
  comparisons) is rejected with actionable migration errors. No scheduling
  or hosting is added.
- **Standards / canonical-config drift** remains as a **separate
  capability**: it compares shared tooling files against the bundled
  canonical set exactly as before, and its results **do not contribute to
  the sloppiness index** in either direction. It is not expanded in this
  release.

---

## 12. CLI & SDK surface

```
trellis audit <path>           # measure + score; print report
  [--json|--md] [--out <file>]
  [--baseline <report.json>]   # compare against a saved report (§9)
  [--config <trellis.yaml>]
  [--history]                  # opt-in persistence (§10)
trellis compare <a.json> <b.json>   # artifact comparison without an audit
trellis fleet                  # optional multi-repo run (§11)
trellis report                 # history views (only with --history data)
trellis standards              # canonical drift (separate capability, §11)
```

- Terminal output shows headline index + completeness, raw metric summaries,
  score contributions, ranked hotspots, and safeguard evidence; JSON carries
  the full structured report; Markdown is a bounded summary. Every displayed
  score carries its direction and scoring version (§3.4).
  *(Landed, trellis-a059: `src/report/audit-{terminal,json,markdown}.ts`
  render the §6.4 report over the shared helpers in `audit-format.ts` — the
  index always shows `N/100 · lower is better · scoring <version>`, never a
  percentage; hotspot/finding lists are bounded with totals printed; the JSON
  renderer re-validates the contract at the boundary. `audit-fixtures.ts`
  audits the five render-fixture repositories — clean, sloppy,
  mixed-language, incomplete, function-free — through the real core. CLI/SDK
  wiring landed with trellis-9a88.)*
- Retired flags (`--rubric-version`, `--min-level`, provider/model/cache
  knobs, …) fail with a useful "removed in the deterministic pivot" error,
  not a silent ignore.
- The SDK (`src/client/`) exposes the same audit/compare/fleet/report calls
  over the same core; deep-equal tests prove CLI and SDK are one code path.

*(Landed, trellis-9a88: `src/audit/run.ts` — `runWorkspaceAudit(root)` is the
one composed service the CLI (`trellis audit`) and SDK (`audit()`) both fold:
configure (root discovery or an explicit `--config` file) → the pure
`auditWorkspace` measurement pass → optional `--baseline` artifact comparison
→ the declarative §6.5 policy assessment → opt-in `--history` persistence.
The default audit is stateless (§8): no database without `--history`, no
report file without `--out`. `trellis compare <a.json> <b.json>` compares two
saved artifacts with no audit (`src/compare/load.ts` `compareArtifacts`);
`src/report/comparison.ts` renders comparisons and policy assessments for the
terminal/Markdown views while JSON stdout stays the pure §6.4 report so it
can feed a later `--baseline`. Exit codes follow §9: `0` clean, `2` when the
declarative policy trips (report on stdout, reasons on stderr; `compare`
exits `2` on an incompatible pair), `1` on operational errors (invalid
config/baseline artifact). Retired readiness-era flags — `--rubric-version`,
`--rubric-dir`, `--canonical`, `--fail-on`, `--min-level`, `--no-persist`,
`--output`/`--no-output`, `--no-cache`, `TRELLIS_PI_BIN` — fail with
actionable "removed in the deterministic pivot" errors, and the SDK service
rejects the same retired option keys (`src/legacy.ts`
`rejectRetiredAuditOptions`). Deep-equal tests prove the CLI and SDK share
one measurement and policy code path. The legacy `fleet`/`report`/`rubric`/
`drift` commands remain operative until trellis-8366 adapts them.)*

---

## 13. Tech stack & conventions

Unchanged from the warren/burrow stack:

- **Runtime:** Bun (runs TS directly, no build step for the CLI).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Parsing:** the pinned TypeScript compiler API — one shared parse layer
  reused by all metrics within an audit.
- **Validation:** zod at every external boundary (contracts, configuration).
- **Lint/format:** Biome, `--error-on-warnings`.
- **Storage:** `bun:sqlite` (opt-in history only).
- **CLI:** commander; **logging:** pino.
- **Conventions:** kebab-case filenames, tab indent / 100-col, `.ts` import
  extensions, tests as `<name>.test.ts` beside the unit, golden fixtures
  under `__golden__/`. trellis keeps the quality-gate ratchets and audits
  itself with the deterministic audit once it lands (dogfood, §14).

### 13.1 api>cli>sdk core discipline

All behavior lives in the surface-agnostic core modules under `src/`; the
CLI is a thin commander pass-through and the SDK a typed client whose types
mirror the core (`// Mirrors src/<x>`). There is exactly one implementation
of each operation, so surfaces cannot drift. There is **no HTTP server**; a
network API remains a deferred surface over the same core.

---

## 14. Transition from the readiness product

The pivot is delivered as a **staged, forward-chained plan** (`pl-b2ea`, 23
issues under feature `trellis-253e`). This section is the map; it describes
sequence, not completion. Until a stage lands, the corresponding behavior
above is **specified but unbuilt**, and the legacy implementation in `src/`
remains the operative code.

1. **Contract** (this document) — the deterministic product contract replaces
   the readiness specification. *(This stage.)*
2. **Disconnect** — agent execution is removed from every public audit path
   (CLI, SDK, fleet, persistence defaults); legacy provider/cache flags are
   rejected with actionable errors.
3. **Delete** — the investigation subsystem, its cache API, golden capture
   tooling, and os-eco scoring overlays are removed; historical migrations
   stay append-only and existing user data is untouched.
4. **Contracts** — versioned measurement/finding/configuration schemas (§6).
5. **Foundation** — source discovery & classification (§3.1); the shared
   parse layer and function inventory.
6. **Metrics** — complexity & erosion (§5.1–5.2); duplication feasibility
   decision then implementation (§5.3); workspace-aware import resolution
   then cycle measurement (§5.4); safeguard inspection (§5.5).
7. **Score & report** — the provisional formula (§7); the deterministic audit
   core; terminal/JSON/Markdown renderers.
8. **Policy & history** — baseline comparison and failure policies (§9);
   opt-in history with legacy separation (§10).
9. **Surfaces** — CLI/SDK rewiring (§12); fleet & standards adaptation (§11).
10. **Validation** — a fixed TypeScript corpus (recorded revisions, sizes,
    machine, analyzer versions) exercises paired refactors — clone removal,
    branch growth, cycle introduction — to validate score behavior and
    performance, calibrate the provisional formula if evidence requires it
    (bumping the scoring version), and set runtime/memory budgets. No model
    judgments or network access occur during an audit; corpus acquisition is
    a separate preparation step.
11. **Release** — documentation and portable examples reflect the pivot; the
    legacy Seeds backlog is reconciled (keep / superseded / deferred, with
    reasons); the breaking release passes complete offline acceptance and
    all quality gates with no model/provider configuration shipped.

**Legacy score separation** is a hard rule throughout: readiness scores and
levels are a different quantity from the sloppiness index. They are preserved
in history, labeled as legacy, and never numerically compared (§10).

**Dogfood** after the pivot: trellis audits itself with the deterministic
audit; a regression in its own index is a real failure. (The retired
"band L4+ against the readiness rubric" gate is gone with the rubric.)

---

## 15. Deferred / open

- **Unused-code analysis** — dead exports, unreachable modules (deferred per
  §2; the natural next metric family).
- **Broader architecture rules** — enforced layering/boundaries beyond cycle
  detection.
- **Project verification execution** — actually running checks; trellis stays
  an inspector, not a runner.
- **New language adapters** — Swift/Python and others; the contracts keep
  `unsupported` coverage honest so this can land later without a schema
  break.
- **Web dashboard, hosted/scheduled service, auto-remediation fan-out,
  README badges** — adjacent surfaces over the same core, not now.

---

## Appendix A — provenance

- The pre-pivot readiness design (9 categories / 90 criteria, coverage-aware
  leveling, 4 investigation areas, Pi-RPC provider, canonical drift) was
  de-branded from `../notes/` and a day-job rubric v0.2.0 as a clean-room
  reimplementation. It is superseded by this document; its history lives in
  git and in legacy run rows (§10). Canonical-config drift (§11) is the one
  capability carried forward unchanged.
- The pivot rationale: the readiness product's differentiating layer was its
  LLM investigation pass, which made scores non-reproducible per commit and
  coupled a measurement tool to provider availability. The deterministic
  core — the part that was always trustworthy — is the product.
