# trellis — deterministic TypeScript sloppiness audit

> Spec. Codename **trellis** — the structure that keeps growth aligned.
> Created 2026-06-06 as an agent-readiness audit; **pivoted 2026-09** (plan
> `pl-b2ea`, feature `trellis-253e`) to a deterministic TypeScript sloppiness
> audit. This document is the authoritative product contract for the pivoted
> tool. The pivot is a **breaking change**: the 90-criterion readiness rubric,
> maturity levels, and the LLM investigation layer are retired, not
> reinterpreted. See §14 for the staged transition and what is actually built
> at any moment — nothing in this document claims unbuilt behavior. §16
> records the optional-provider integration contract under the same rule.

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
   product bug. Optional analysis providers (§16, contracted) are
   deterministic local tools — never models or agents — and this invariant
   covers them without exception.
2. **Offline and zero-footprint by default.** The first audit of a repo
   requires **neither Git nor credentials, a database, network access, or
   installed project dependencies**. It reads files as they exist on disk
   (dirty worktrees included), never runs the target's scripts or installs
   its packages, and writes nothing unless the operator explicitly requests
   an output file, a baseline, or history persistence. Optional providers
   (§16, contracted) are explicit opt-in only: enabling one never relaxes
   these rules for the native audit, and the provider run itself stays
   offline, never writes to the target, and never acquires tools at audit
   time (§16.4).
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

- **Unused-code analysis** (dead exports, unreachable modules, orphan files)
  as a native, scored capability — optional advisory reachability evidence
  from a provider is contracted in §16.
- **Broader architecture rules** (layering constraints, boundary enforcement,
  dependency-direction policies beyond cycle detection) — optional advisory
  evidence for declared rules is contracted in §16; native enforcement stays
  deferred.
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

Two further states apply to optional provider analyses (§16.2, contract —
plan `pl-43c5`): `unrequested` (not enabled for this run; no evidence and
no invented metrics) and `unavailable` (enabled but could not run —
missing or malformed pinned tool, exhausted execution limits; located, with
a reason, never a silent clean result). Provider states never roll into
the native completeness rollup above: overall evidence completeness and
score completeness are independent quantities (§16.2).

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

Deterministic module layout (legacy compatibility modules omitted — see §14):

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
- **Minimum clone size** (calibrated by the corpus stage, trellis-e924 —
  see `docs/corpus-validation.md`: at 50 tokens the corpus and the trellis
  self-audit were dominated by idiomatic-structure matches; at 100 the
  surviving groups are true copy-paste): **100 normalized tokens and 3
  lines**, both required.
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
  implementation (trellis-6e4c; confirmed by the trellis-e924 corpus run —
  the largest observed source set keeps an order-of-magnitude headroom):
  a **token budget** of 2,000,000 normalized tokens per source set and a
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

**Revision (trellis-06f8, plan `pl-43c5`, 2026-09-17):** the decision above
stands unchanged for the **native default engine and scoring basis** — no
jscpd form replaces the trellis detector or feeds the score. Its blanket
restriction reading — no subprocess engine may ever run in any analysis
slot — is explicitly narrowed by the optional-provider contract (§16):
pinned jscpd 5.2.1 may run as a **supplemental, unscored** duplication
evidence provider under the controlled execution boundary (§16.4). Spike
2 ([`docs/research/provider-spike.md`](docs/research/provider-spike.md))
showed the 5.2.1 binary supports `--ignore-identifiers`,
`--ignore-literals`, `--max-gap-lines` and `--similarity`, which the
type-1-only assessment above did not reflect. Native clone groups and
overlap-union line accounting remain authoritative (§16.5); a provider
backend promotion or provider-derived weight would require its own
versioned calibration (§16.5).

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
providers:                             # optional provider selection (§16.4) — additive, unscored
  jscpd:                               #   evidence: no provider requested by default
    mode: normalized                   #   one match mode per request (exact | normalized | near)
  dependency-cruiser:                  #   declared architecture rules (trellis-89be) — inline data,
    rules:                             #   never an executable .dependency-cruiser config; an absent
      - kind: boundary                 #   rules block declares no architecture claims
        name: domain-must-not-import-ui
        allowance: forbidden           #   forbidden, or allowed as an explicit exception
        edges: [runtime, type-only]    #   the dependency kinds the rule governs
        from: { path: "^src/domain/" } #   start-anchored, repo-relative scope selectors
        to: { path: "^src/ui/" }
      - kind: cycle                   #   cycle and unresolved checks are rules too —
        name: no-runtime-cycles        #   runtime and type-only cycle policies stay distinct
        edges: [runtime]
policy:                                 # failure policy only — never mutates scoring weights
  maxIndex: 40
  regression:                           # score regression vs a baseline report (§9)
    maxIncrease: 2                      # absolute tolerance, in index points
    maxIncreasePercent: 10              # relative tolerance, % of the baseline index
  budgets:
    duplication.density: { max: 0.05 }
  failOnNew: [import-cycle, complexity.hotspot]
  requireEvidence: [jscpd]              # demanded provider evidence (§16.3): absent or
                                         #   failed evidence fails the run, never the score
```

Provider selection (§16.4, `providers`) is declarative data with the same
rules: the block names exactly the known optional providers (an unknown id
is invalid configuration), a delivered provider resolves per run, and a
requested-but-undelivered or gated capability (SonarJS, §16.7) resolves to
located `unsupported` evidence. Selection never mutates scoring (§16.5): a
requested provider adds namespaced advisory evidence alongside the native
duplication result and changes neither the native measurement nor the
score; the default audit (no block) requests nothing, stages nothing and
launches nothing.

Architecture rules (`providers.dependency-cruiser.rules`, trellis-89be)
are the bounded declarative dependency-rule subset — boundary
(allowed/forbidden from/to scope selectors over explicit runtime /
type-only edge kinds), cycle (per edge kind, so type-only and runtime
cycle policies stay distinct) and unresolved rules as inline data.
Unknown rule kinds, executable `.dependency-cruiser` configs, ambiguous
rule sets and invalid patterns are rejected at config-load time; a request
without rules declares no architecture claims — zero rules is never
coherence, and no layering is inferred from directory names. The compiled
policy's normalized digest rides the analysis identity (§16.2), so a
changed declared architecture is a changed measurement — never silently
reported as code churn. The adapter (trellis-adbf) turns compiled rules
into coverage-checked evidence; until it delivers, requests resolve to
located `unsupported` evidence.

Policy budgets gate the run; they never silently change how the index is
computed (§7). A budget key may also name a provider's namespaced evidence
(`provider.jscpd.pairs`) — evaluated only over that analysis's carried
evidence, never a fabricated zero — and `requireEvidence` lists the optional
provider analyses (§16.1 ids) whose evidence the policy demands: a required
analysis that is unrequested, unavailable, unsupported or incomplete fails
the run closed (§16.3) even when the native score is complete, while an
absent optional provider with no requirement never violates policy and
never changes the score (§16.5).

### 6.6 Provider evidence (contract — §16; lands with plan `pl-43c5`)

When optional providers ship, their observations join the report as an
**additive, namespaced provider-evidence area** — never inside `metrics`,
never as native finding kinds, never inside `score`. Each entry carries
provider identity, analysis identity, observed coverage, one of the §16.2
states, and located findings. The schema-version governance above applies;
older reports without the area remain valid, and its absence reads as
`unrequested` (§16.6), never as a failure.

---

## 7. Scoring — the provisional formula

Scoring is a **pure function** of structural raw metrics. The initial formula
is **provisional** (`scoringVersion: 0.2.0-provisional`) pending calibration
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
- **Providers never score** (contract, §16.5): optional provider observations
  are unscored evidence — the formula consumes native metrics only. Backend
  promotion or provider-derived weights require a separately versioned
  calibration; they are never part of this scoring version.

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
| `complexity-erosion` | 0.50 | `erosion.eroded-share.production` @ 0.25; `erosion.eroded-count.production` log scale 20 |
| `duplication` | 0.30 | `duplication.density.production` @ 0.15; `duplication.groups.production` log scale 15 |
| `import-cycle` | 0.20 | `import-cycle.density` @ 0.10; `import-cycle.groups` log scale 5 |

- Density terms normalize linearly: `100 × min(1, value / saturation)`.
  Absolute counts use `b = ln(1 + count / scale)`, then `100 × b / (1 + b)`.
  There is no finite count saturation and no repository-size denominator.
  Each dimension retains a 50/50 count/density blend. Clean additions cannot
  reduce count contributions or erase hotspot weight; unsaturated densities
  can still decrease. The integer headline can round away small changes.
  This is count non-dilution, not an invariant total score under clean additions.
  See [count calibration](docs/count-calibration.md) for evidence and alternatives.
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
- **No network.** All native analysis is local parsing and arithmetic; tool
  acquisition (if any) is a separate preparation step, never part of an
  audit. *(Revised for optional providers by the §16 contract: an
  explicitly enabled provider may run as a controlled local subprocess —
  still no audit-time acquisition, §16.4.)*
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
- **Controlled optional-provider execution** (contract, §16.4 — not yet
  implemented). When a provider is explicitly enabled, its pinned local
  tool may run over an isolated staged source view using trellis-owned
  temporary scratch with owned cleanup; it never writes to the target,
  never accepts executable target configuration or arbitrary command
  strings, and never downloads. The default audit — and the native
  measurement pass of every audit — is exactly as specified above.

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
- **Provider failure semantics** (contract, §16.3 — not yet implemented).
  A requested optional provider that cannot run or cannot cover its scope
  becomes located `unavailable`/`incomplete` evidence in the emitted report
  — never fabricated metrics, never a silent clean result. A declarative
  requirement violated by it trips policy (exit `2`); invalid provider
  configuration or inability to run the audit remains operational error
  (exit `1`).

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
closed on an incompatible one. The CLI (`trellis compare`, `--baseline`)
and SDK wiring landed with trellis-9a88.)*

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

*(Landed, trellis-8366: `src/fleet/` loads the pivoted `targets.yaml`
(id/path/config/canonical; readiness `skip`/`languages` and investigation
defaults rejected with actionable migration errors), runs each target
through the same `runWorkspaceAudit` the single-repo surfaces fold, and
aggregates a `FleetReport` whose entries preserve the full §6.4 report and
the §9 policy assessment — deep-equal to independent core audits. Drift
rides along per target as non-scoring evidence; it never enters the index
or the exit rollup (`assessFleet` fails on target errors and tripped
declarative policies only). Fleet runs are stateless by default;
`--history` records each run and surfaces index moves against stored
compatible baselines. `src/history/` renders the sloppiness dashboard —
latest-run snapshot with compatible index deltas plus per-repo
§3.5-compatible series — with legacy readiness runs in a visibly distinct,
never-compared section (§10).)*

*(Per-target provider scope, trellis-f3e5 — plan `pl-43c5` step 20: optional
provider selection rides each fleet member's own configuration through the
same core service — the fleet layer holds no provider logic, planning or
policy of its own. Each member stages its own isolated source view under
trellis-owned scratch (a fresh temp directory per analysis, cleaned on every
exit path) and carries its own namespaced, unscored evidence on its own
report; a member without a selection stays byte-identical to a native-only
audit, and one member's provider failure, unavailability or cleanup problem
never touches another's report, score or the exit rollup. The fleet stays
sequential (no scheduling service), so members can never share or race on a
scratch path, and mixed situations — one member with complete evidence, one
unavailable, one unrequested — stay explicit per entry; the rendered views
project each member's carried analysis states per target, never summed or
averaged into anything score-like.)*

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
  mixed-language, incomplete, function-free — through the real core.)*
- Retired flags (`--rubric-version`, `--min-level`, provider/model/cache
  knobs, …) fail with a useful "removed in the deterministic pivot" error,
  not a silent ignore.
- The SDK (`src/client/`) exposes the same audit/compare/fleet/report calls
  over the same core; deep-equal tests prove CLI and SDK are one code path.

*(CLI/SDK landed, trellis-9a88: `trellis audit` folds `runWorkspaceAudit`
(`src/audit/run.ts`) — configuration (`--config`, else the root's
`trellis.yaml`) → the deterministic core → baseline resolution
(`--baseline`, else the latest compatible stored run when `--history` is
on) → declarative policy assessment → opt-in persistence. The default run
is stateless: no database is opened and no report file is written unless
`--history`/`--out` ask. `trellis compare` folds `runComparison`
(`src/compare/run.ts`) — two artifacts, no audit — with terminal/Markdown
views in `src/report/compare-render.ts`; an incompatible pair fails closed
(exit 2, the comparison still emitted). Retired readiness/investigation
flags are hidden commander options that fail fast with actionable
messages. The SDK's `audit`/`compare` are direct calls to the same
services; deep-equal parity tests cover measurement and policy.
`fleet`/`report` adapted with trellis-8366 (§11);
`drift`/`standards` remain separate canonical-config capabilities. The
release acceptance stage retired public `rubric` and SDK readiness exports;
legacy internals remain for history compatibility and regression fixtures.)*

---

## 13. Tech stack & conventions

Unchanged from the warren/burrow stack:

- **Runtime:** Bun (runs TS directly, no build step for the CLI).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Parsing:** the pinned TypeScript compiler API — one shared parse layer
  reused by all **native** metrics within an audit. *(Optional providers,
  per the §16 contract, may run their own pinned engines behind the §16.4
  execution boundary, with their parser recorded in analysis identity
  — the shared-parse rule governs native measurement and is never weakened
  there.)*
- **Validation:** zod at every external boundary (contracts, configuration).
- **Lint/format:** Biome, `--error-on-warnings`.
- **Storage:** `bun:sqlite` (opt-in history only).
- **CLI:** commander; progress and handled errors write to stderr.
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
the delivery sequence. All 23 plan stages are complete; the final evidence
and bounded follow-ups are recorded in
[`docs/release-acceptance.md`](docs/release-acceptance.md). Internal legacy
modules remain for history compatibility and regression fixtures, outside
the public deterministic audit paths.

1. **Contract** (this document) — the deterministic product contract replaces
   the readiness specification.
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
  §2 as a native capability; optional advisory reachability evidence is
  contracted in §16).
- **Broader architecture rules** — enforced layering/boundaries beyond cycle
  detection (optional advisory evidence for declared rules is contracted in
  §16; native enforcement stays deferred).
- **Project verification execution** — actually running checks; trellis stays
  an inspector, not a runner.
- **New language adapters** — Swift/Python and others; the contracts keep
  `unsupported` coverage honest so this can land later without a schema
  break.
- **Web dashboard, hosted/scheduled service, auto-remediation fan-out,
  README badges** — adjacent surfaces over the same core, not now.

---

## 16. Optional quality-evidence providers (integration contract — plan `pl-43c5`)

> **Contract only — nothing in this section is implemented.** This is the
> integration contract for optional provider evidence (plan `pl-43c5`,
> feature `trellis-8ac1`, 30 forward-chained issues; research input
> [`docs/research/provider-spike.md`](docs/research/provider-spike.md)).
> It fixes scope, trust and score semantics for the implementing steps
> (from `trellis-90d6`); it changes no delivered behavior of the completed
> foundation (§14) — it builds on that foundation and never reopens a
> closed `pl-b2ea` stage. **Native analysis remains the default and the
> authoritative measurement and scoring basis throughout the plan.**

### 16.1 What a provider is — and is not

A **provider** is a pinned, deterministic local analysis tool that trellis
may run — **only when explicitly enabled by the operator** — to add
supplemental engineering-quality evidence to a report. Contracted
candidates: jscpd (duplication evidence), dependency-cruiser (declared
architecture-rule evidence), Knip (contextual reachability candidates);
SonarJS is gated (§16.7).

A provider is **not**: a model, agent, or network service (the §1 no-model
invariant covers providers without exception); a replacement for any
native analyzer; a scored signal; a runner of the target's scripts or
configuration; or any new default behavior. Optional providers are
supplemental in this delivery, and a provider's absence never marks code
clean or dirty.

This contract **explicitly revises two foundation restrictions** — the
restrictions, never the guarantees:

- **Shared-parser restriction (§13).** "One shared parse layer reused by
  all metrics" remains the rule for **native** metrics. An optional
  provider may run its own pinned engine (e.g. jscpd's Rust engine,
  Knip's parser) behind the §16.4 execution boundary, recording its
  parser/version in analysis identity (§16.2); trellis validates the
  provider's raw output before it becomes evidence.
- **Subprocess restriction (§8 "local parsing and arithmetic").** The
  native measurement pass is unchanged. An explicitly enabled provider
  may run as a **controlled local subprocess** over an isolated staged
  view — still offline, still never a target command, still no
  audit-time acquisition (§16.4).

The §5.3 jscpd decision is narrowed, not reversed (see the revision note
there): jscpd remains rejected as the native default engine and as a
scoring source; it is permitted as an optional, pinned, unscored
evidence provider.

**Unchanged guarantees:** no-model execution; no target commands and no
executable target configuration; no audit-time downloads (tool
acquisition is a separate operator preparation step — pinned and
discoverable per `trellis-ff52`); and the default audit stays offline and
zero-footprint (§8) — an unrequested provider runs nothing.

### 16.2 Identity, coverage, status, and states

Every provider analysis recorded in a report carries:

- **Provider identity** — a stable provider id, the pinned tool version,
  the trellis adapter version, and the exact mode/option set supplied.
- **Analysis identity** — what the analysis consumed: the input snapshot
  identity (selected source sets and files with content fingerprints),
  the provider's own parser/version where it differs from trellis's
  pinned TypeScript, and the trellis-owned declarative options in
  effect. Two analyses are identical only when all of these match.
- **Observed coverage** — what the analysis actually observed
  (files/lines, per source set), **asserted from the provider's own
  evidence, never inferred from exit status** (the spike recorded a
  successful empty graph from dependency-cruiser without its supported
  TypeScript parser, and filesystem-alias false positives from Knip).
  Coverage is evidence, not cleanliness: uncovered surface is reported,
  never scored as clean.
- **Status** — **required** or **advisory**, declared by the audit's
  declarative policy. Required evidence is demanded; advisory evidence is
  requested but optional. Unrequested or advisory absence never
  invalidates the native score (§16.5); a violated requirement trips
  policy (§16.3).

The allowed states for a provider analysis are exactly five:

| state | meaning |
|---|---|
| `complete` | ran over its full intended scope, with observed coverage asserted |
| `incomplete` | ran but did not cover the full intended scope — what and where is recorded |
| `unavailable` | enabled but could not run — missing or malformed pinned tool, exhausted execution limits; located, with reason |
| `unsupported` | enabled but the capability is not supported for this scope/platform/inputs — including a gated, explicitly deferred capability (§16.7); located, with reason |
| `unrequested` | not enabled for this run; no evidence exists |

Rules:

- **No invented metrics.** An absent execution is recorded as its state;
  it never materializes zero-valued metrics, "0 findings", or clean
  coverage. Absence is explicit.
- **No conflation with native states.** Provider states never roll into
  the native completeness rollup (§3.3): overall evidence completeness
  and score completeness are independent quantities. An optional
  provider's `unavailable` state never makes the native score partial
  and never blocks the headline index (the report-level split is
  designed in `trellis-a24d`).
- **Truthful success.** A successful run with empty or partial observed
  coverage is reported as exactly that — never as a silently clean
  result.

### 16.3 Failure semantics and exit codes

> **Delivered (trellis-68b9, plan `pl-43c5` step 7):** the declarative
> requirement surface is `policy.requireEvidence` in `trellis.yaml` (§6.5) —
> a list of supported analysis ids (§16.1), validated as pure data at
> config-load time (native `trellis.*` ids and `provider.*` evidence ids are
> rejected actionably; no command strings). `assessPolicy`
> (`src/compare/policy.ts` + `policy-evidence.ts`) fails the run closed on
> every unmet requirement — unrequested, unavailable, unsupported or
> incomplete — including a located `unsupported` citation for a deferred
> capability (§16.7), while budgets and `failOnNew` entries under the reserved
> `provider.` namespace evaluate over that analysis's carried evidence
> (step-6 compatibility rules apply) and never fabricate zero values.

- A **requested optional-provider failure is located unavailable/incomplete
  evidence**: the report carries the provider id, state, reason, and —
  where known — the location. It never becomes a clean result and never
  fabricates metrics.
- A **declarative requirement can trip policy**: when the audit's policy
  declares provider evidence required and that evidence is `unavailable`,
  `unsupported`, or `incomplete`, the run exits **`2`** — the report is
  still emitted to stdout, reasons go to stderr (§9). An advisory-only
  provider failure leaves the exit unchanged; the visible evidence in
  the report is the failure's surface.
- **Operational error `1` is preserved** for invalid configuration and
  inability to run the audit: a provider request that fails schema
  validation (unknown provider id, malformed options, contradictory
  requirements) fails fast with no report, and a failure that prevents
  the audit itself from running is operational. A *valid* request whose
  execution fails is evidence, not an abort — the native audit still
  runs and emits.
- Policy failure and operational failure remain always distinguishable
  (§9).

### 16.4 Execution, trust, and storage boundary

- **Default: no scratch.** A native audit (no provider enabled) creates
  no scratch files and writes nothing — §8 is unchanged.
- **Opt-in external execution may use isolated temporary storage owned by
  trellis** — a staged source view and working area — with trellis-owned
  cleanup when the run ends, and **never a write to the target
  workspace**. A cleanup failure is a visible, reported condition, never
  silently dropped.
- **Declarative requests only.** No executable target configuration and
  no arbitrary command strings are accepted. Provider requests are
  trellis-owned declarative data: a validated schema, pinned artifacts,
  trellis-supplied options. The target's own tool configuration (a
  discovered `.jscpd.json`, a `dep-cruiserrc.js`, …) is never executed
  or trusted — the spike showed jscpd auto-discovers ancestor configs;
  adapters must prevent that.
- **Trust boundary — supported installation.** The supported execution
  context is a local tool installation prepared by the operator (pinned,
  discoverable offline, `trellis-ff52`). trellis never installs, updates,
  or downloads tools at audit time. This boundary is a **controlled
  execution** statement, not a sandbox claim: it does not certify the
  execution environment as safe for arbitrary untrusted code. Resource
  limits, staged input snapshots, and raw-evidence validation (steps
  `trellis-eddc`, `trellis-2fe6`) are the compensating controls.
  > **Delivered (`trellis-ff52`, plan `pl-43c5` step 11):** the supported-
  > tool manifest/resolver (`src/providers/manifest.ts` +
  > `src/providers/resolve.ts`, see `docs/provider-tools.md`) pins jscpd
  > 5.2.1 as an isolated devDependency, resolves it only from the
  > operator-prepared local installation via trellis-owned `node_modules`
  > discovery (never PATH/`bunx`, never at audit time), and verifies the
  > resolved artifact against recorded digests before the process-runner
  > registry (`src/providers/process.ts`) may run it — with honest
  > per-platform execution records (`tested` / `research-tested` /
  > `declared-untested`) instead of universal platform claims.
  > **Delivered (`trellis-adbf`, plan `pl-43c5` step 22):** the manifest
  > also pins dependency-cruiser 18.3.1 — a pure-JavaScript distribution
  > whose launcher runs under trellis's own runtime through the controlled
  > process runner, with the tool's locally resolved TypeScript parser
  > version recorded in analysis identity before anything runs (a missing
  > parser produced a successful empty graph in the research record;
  > `src/providers/dependency-cruiser/` owns the adapter, its generated
  > tool config and its coverage-checked evidence).
- **Never**: target scripts, target verification, models, network
  fetches, opportunistic downloads, or credentials.

### 16.5 Scoring semantics

- **Provider observations are unscored under this plan.** The sloppiness
  index and its contributions are computed exclusively from native
  metrics under the calibrated formula (§7.1 constants, frozen after the
  `pl-b2ea` calibration). Provider data never enters the score in either
  direction.
- Provider findings live in their own **namespaced evidence area** of the
  report (§6.6) — located findings, never in the native metrics map and
  never under native finding kinds.
- **Absence never invalidates a native score.** An optional provider that
  is unrequested, unavailable, or incomplete does not make the native
  score partial and does not block the headline index (§16.2).
- **Backend promotion or extra weights require a separately versioned
  calibration** — an explicit scoring-version bump with its own corpus
  validation, outside this plan. A provider replacing a native analyzer
  as the default is likewise outside this plan.
- Summing provider counts into any composite quality number is rejected:
  one problem can trigger several providers, and provider absence can
  mean missing context rather than quality (spike record).

### 16.6 Compatibility and versioning rules

- **Comparisons evaluate per basis** (§9; designed in `trellis-bd0c`):
  - *Scored basis* — the native index compares under the existing
    analyzer/scoring/configuration compatibility rules. Provider
    presence, absence, or upgrade never changes the native index and
    never fragments score history; advisory-only provider changes
    cannot make two otherwise-compatible reports incompatible.
  - *Scored-measurement changes* — native analyzer/scoring changes keep
    the existing fail-closed behavior (§3.5, §9): incompatible pairs are
    reported explicitly, never silently trended.
  - *Evidence basis* — provider evidence compares only across identical
    provider identity (id + pinned tool version + adapter version +
    mode/options) and identical input/config identity; mismatches are
    reported explicitly (incompatible or caveated), never silently
    trended.
- **Input/config identity**: a provider observation's identity is its
  provider identity plus its analysis identity (§16.2). A changed option
  set or a changed source scope is a different analysis — never
  presented as the same evidence continuing a trend.
- **Older artifacts remain valid**: reports produced without providers
  (or with fewer) load and compare. Missing provider evidence in an
  older artifact reads as `unrequested`, never as a regression or an
  `unavailable` failure. Provider availability added later never
  rewrites stored history (§10).
- **Schema evolution**: provider evidence is an additive, versioned
  report change (§6.6; steps `trellis-a24d`, `trellis-bba6`); older
  schemas stay loadable per §9.

### 16.7 Sonar decision gate

SonarJS evidence is **contingent on an affirmative, documented
distribution and metric-interface decision** (`trellis-db3e`). The spike
recorded conflicting license evidence (package metadata reads
`LGPL-3.0-only` while the shipped header identifies the Sonar
Source-Available License v1.0) and that the research metric adapter parses
threshold-zero diagnostics through a pinned research adapter — not a
stable public metric API. Distribution cannot be inferred from metadata.

Until the decision clears a route, Sonar evidence is **explicitly
deferred**: the provider id is known, so a request for it is valid
configuration, but it resolves to `unsupported` with the deferral reason
recorded. The deferral is visible and policy-testable — a declarative
requirement on it fails closed (§16.3) — and no nonexistent analysis is
ever reported as `complete`. A deferred outcome is a documented capability
state (`trellis-7b99` owns the follow-through), not a claim of
implementation.

> **Decision recorded (`trellis-db3e`, plan `pl-43c5` step 25): DEFERRED.**
> The bounded decision record is
> [`docs/sonarjs-decision.md`](docs/sonarjs-decision.md): the pinned
> `eslint-plugin-sonarjs` 3.0.5 distribution's `LGPL-3.0-only` package
> metadata conflicts with its shipped SONAR Source-Available License v1.0
> text, so no permitted distribution route is established and the research
> diagnostic adapter is not adopted as a metric API. The typed capability
> carrier is `src/providers/capabilities.ts` (a `sonarjs` request is known
> configuration resolving to `unsupported` with the recorded reason); the
> clearance prerequisite is tracked separately as `trellis-7f5d`.

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
