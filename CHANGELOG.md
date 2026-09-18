# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While pre-1.0, breaking changes go in MINOR and additive changes go in PATCH.

## [Unreleased]

- Native hotspots now carry scoped function identity or an explicit ambiguity
  reason, derived from the shared AST (trellis-3d6b). Analyzer 0.2.2 and schema
  1.2.0 preserve native metrics and scoring. Historical 1.0.0/1.1.0 reports
  remain readable; comparisons across the identity transition require a fresh
  baseline. Scoped matching follows in trellis-7cfd.

- Added `trellis guide cleanup` and SDK `guide("cleanup")` with one bundled,
  read-only workflow for behavior-preserving cleanup (trellis-b6f9).

- Cross-provider regressions cover unchanged native scores, independent evidence
  compatibility, combined CLI/SDK/fleet behavior and SQLite history.
- Verified dependency-cruiser 18.3.1 support on macOS ARM64, with shared
  JavaScript launchers accepted only under matching paths and verified digests.
- Added a network-denied provider resource harness and current quality-evidence
  setup/migration guidance, including combined Knip acceptance.
- Verified Knip 6.16.1 on macOS ARM64 with oxc-parser 0.133.0, including
  conformance, mixed provider evidence, test-root compatibility and offline
  resource acceptance. Optional providers still never affect native scores.


### Fixed

- `audit --out` writes the report only to the requested file, including with
  `--json` or `--md`, without duplicating it on stdout (trellis-ad3e).

- CLI reports drain fully when piped, including policy-failure output (trellis-5b25).
- Existing aliased and relative non-source assets no longer produce unresolved
  graph edges; missing assets remain unresolved (trellis-f6b0). Analyzer 0.2.1.
- Count contributions use a bounded logarithmic curve without finite saturation,
  restoring sensitivity above the former 20/15/5 cutoffs (trellis-831b).
  Scoring 0.2.0-provisional preserves count non-dilution and monotonicity;
  earlier scoring versions are not comparable. Evidence: `docs/count-calibration.md`.

### Changed

- **Declarative policy can require provider evidence without changing
  scoring** (trellis-68b9, step 7 of 30 of plan `pl-43c5`, SPEC §16.3): the
  `policy` block of `trellis.yaml` gains `requireEvidence` — a list of
  supported analysis ids (the external provider ids of the supported-provider
  capability table). A required analysis that is unrequested, unavailable,
  unsupported or incomplete fails the policy assessment closed (exit `2`,
  the report still emitted) even when the native score is complete and
  clean; an absent optional provider with no requirement never violates
  policy and never changes the score. Requiring a capability recorded as
  resolving to `unsupported` — the deferred SonarJS decision — yields a
  located violation citing the recorded reason and decision record, never
  a crash or a silent pass; unknown ids fail closed naming the supported
  vocabulary. Metric budgets and `failOnNew` kinds under the reserved
  `provider.` namespace now evaluate over that analysis's carried
  evidence: only a complete analysis's emitted value is budgetable (partial
  evidence never feeds a budget — fewer analyzed files must never pass as a
  smaller value), a missing value fails closed when the analysis is also
  required and is otherwise skipped with the absence stated (never a
  fabricated zero), and new findings are claimed only over step-6
  `comparable` evidence — a changed basis skips the check and absence on a
  side never reads as regression churn. Configuration stays declarative
  data: requirements are pure ids — native `trellis.*` ids, `provider.*`
  evidence ids, and any command string are rejected at config-load time as
  operational errors (exit `1`). Native max-index, regression, budget and
  new-finding semantics are unchanged, and audit, saved comparison and
  fleet consume the one `assessPolicy` (`src/compare/policy.ts` + new
  `policy-evidence.ts`).
- **Comparisons evaluate compatibility per measurement and scoring basis**
  (trellis-bd0c, step 6 of 30 of plan `pl-43c5`, SPEC §16.6): `src/compare/`
  splits the single whole-report comparability gate into two independent
  bases. The **scored basis** (`compatibility.ts`, new) keeps the established
  fail-closed rules — analyzer/scoring versions, scored metric catalogs
  (pre-provider 1.0.0 artifacts still read with every metric as a score
  input), supplied configurations — and adds per-measurement checks over the
  recorded analysis identity: a scored analysis whose pinned tool/adapter,
  parser, or normalized options changed is a `scored-measurement`
  incompatibility, and a changed declared scored-analysis set is a
  `scoring-basis` one. The **evidence basis** (`evidence.ts`, new) compares
  each carried provider by recorded identity: producer and scope semantics
  gate the evidence diff (changed tool/parser/options/selection is an
  explicit noncomparable dimension with coded reasons — never fictitious
  deltas or new/resolved finding churn), while changed content fingerprints
  are the expected source-revision input, caveated as `input-revision-changed`.
  Absence reads as `unrequested` on its side — never a regression — and
  partial/unavailable evidence is never diffed. Advisory-only changes
  (adding, removing, or upgrading an optional provider) never make two
  otherwise-compatible reports incompatible, and never affect the native
  score comparison or its policies. A 1.0.0 ↔ 1.1.0 artifact pair compares
  the scored basis explicitly (`schema-span` caveat; the pre-provider
  side's evidence reads as unrequested) instead of failing wholesale;
  `metric-set` no longer trips on advisory metric additions (they diff with
  a `null` side). `compare.ts` composes the bases; `diff.ts` (new) holds the
  shared metric/finding diffs; policy assessment consumes only the scored
  basis, so provider evidence incompatibility never trips score-regression
  or new-finding policies.
- **Audit orchestration consumes the registered native analyzers without
  changing native behavior** (trellis-1e66, step 4 of 30 of plan `pl-43c5`,
  SPEC §16): the measure phase now selects and orders analyzers through the
  internal capability registry (trellis-cb51) and folds the selected
  execution list's results generically — `src/audit/audit.ts` runs each
  registered measured analyzer through its step-3 wrapper over the one
  shared parse, feeding the cycle analyzer the exact produced graph run,
  and `src/audit/assemble.ts` takes a generic measured-analyses list
  instead of a hardcoded four-analyzer shape. Progress analyzer events
  derive from the selected execution list (registry order, counts from the
  list). Report shape, metrics, findings, ordering, score, safeguards and
  exit behavior are byte-identical to the pre-refactor baseline — proven by
  payload-equality tests against the pre-refactor pipeline and core/service/
  CLI parity over dirty, non-Git workspaces; no provider is selected,
  started, or reported, and no report field or version changed.
- **Deterministic pivot release acceptance completed** (`pl-b2ea`,
  trellis-b12d, trellis-d03d): reconciled the legacy backlog with explicit
  keep/superseded/deferred decisions; recorded offline integration, package
  smoke, corpus performance, self-audit evidence, and retained limitations
  in `docs/release-acceptance.md`. Corrected the corpus dilution explanation:
  the paired densities remain saturated, so unchanged score alone does not
  prove general dilution resistance.
- **Public readiness catalog and assessment exports retired** (trellis-a835):
  `trellis rubric` now returns actionable migration guidance and is hidden
  from help. The SDK no longer exports `rubric`, `loadRubric`, readiness
  report/policy types, `assessReport`, or maturity-policy constants. Canonical
  `drift` / `standards` and separate legacy history remain supported. The
  now-unused Pino logger and dependency are removed; package smoke verifies
  the four remaining runtime dependencies.

### Added

- **Knip emits contextual advisory reachability evidence with stable
  ordering** (trellis-8ebc, step 24 of 30 of plan `pl-43c5`, SPEC
  §16.2–§16.5): the `knip` provider's adapter is delivered. A `providers:
  knip: …` request now runs the pinned Knip 6.16.1 — the repository's own
  `check:deps` gate tool, pinned exactly and never a second copy — through
  the controlled process runner over a staged source-only view, under a
  trellis-generated configuration derived from the step-23 reachability
  context: the declared roots as `entry`, the production candidate scope as
  `project`, a generated minimal tsconfig and a generated minimal workspace
  manifest written into owned scratch (never the target's `knip`
  configuration, never the target's manifests), with every runtime registry
  plugin explicitly disabled (the registry's names are derived from the
  pinned artifact itself). Evidence is namespaced `provider.knip.*`, advisory
  and unscored: orphan files, unused exports, unused types and unresolved
  imports are reported as distinct candidate kinds with the tool's own
  positions and stable path/symbol ordering (repeat runs normalize
  byte-identically); declared public surfaces exempt their own candidates
  as visible `public-surface` evidence — a barrel stays a distinct surface
  from the implementation it exposes; and the recorded contextual
  assumptions (omitted entries, unverified dependency context, disabled
  plugin discovery) ride the evidence, since candidates are never confirmed
  dead code and zero candidates never proves overall quality. Coverage is
  checked per run through a pinned exit-code protocol (the findings exit
  code is neutralized and configuration hints are errors): an empty or
  partial pass — a submitted pattern matching no staged file, staging gaps,
  suspect or malformed reports, exhausted limits — is located `incomplete`
  evidence, never a clean pass. The adapter resolves and records the
  `oxc-parser` version the tool finds locally, is registered in the
  step-15 execution plan and the supported-provider capability table
  (the gated set is now SonarJS only), and the CLI's `--provider knip`
  stays a bare-id flag whose richer request lives in the declarative
  block.

- **Reachability configuration records entries, public API and test
  participation** (trellis-5da5, step 23 of 30 of plan `pl-43c5`,
  SPEC §16.1/§16.4): a `knip` request in the `providers` block now
  carries a declarative reachability context — inline data only, never
  an executable `knip` config and never an entry guess. Three keys:
  `entries` (explicit application/script entry files — reachability
  roots), `public` (exported public surfaces, optionally narrowed to one
  named export) and `tests` (whether the measured test files participate
  as reachability roots; default `excluded`). Plugin vocabulary is not
  declarable at all — framework/tool plugin discovery is disabled
  outright, and any future plugin support requires a separately declared
  trust boundary. The pure compilation and context preparation
  (`src/providers/knip/`) resolve the declaration against the audit's
  measured production/test classification: test participation and
  declared test entries supply reachability evidence while staying
  classified test — never scored as production, never diluting a
  production denominator — and a barrel re-export stays a distinct
  surface from the implementation it exposes. Omitted entries,
  unresolvable declarations and missing dependency context become
  recorded contextual assumptions: undefined reachability, never
  confirmed dead code. The normalized configuration digest rides the
  §16.2 provider options through the existing step-6 compatibility seam,
  so a changed declared context is a changed measurement — noncomparable
  evidence, never candidate churn. No adapter yet: requests still
  resolve to located `unsupported` evidence until trellis-8ebc delivers.
- **dependency-cruiser supplies coverage-checked architecture evidence**
  (trellis-adbf, step 22 of 30 of plan `pl-43c5`, SPEC §16.2–§16.5): a
  `dependency-cruiser` request now runs the pinned tool over a staged source
  view through the delivered boundaries — pinned-tool resolution
  (`dependency-cruiser@18.3.1`, a pure-JavaScript distribution recorded in the
  supported-tool manifest with real digests; the launcher runs under
  trellis's own runtime through the controlled process runner), a
  **trellis-generated** tool config + minimal tsconfig in owned scratch
  (never a target `.dependency-cruiser` config), the tool's locally resolved
  TypeScript parser version recorded in analysis identity (a missing parser
  produced a successful empty graph in the research record — the adapter
  refuses to run blind), and raw-report validation before any normalization.
  **Coverage is the point**: a successful empty or partial graph is
  `incomplete` with the missing files named — never a clean pass with zero
  violations — and builtin/external/unresolved-local stub nodes are
  preserved separately from production nodes. Runtime and type-only edge
  flavors stay distinct (separate cycle rules, `dependencyTypes` filters in
  the generated rules, `type-only` recorded per finding), `allowed` boundaries
  apply as explicit exceptions recorded as visible evidence (the tool's own
  `allowed` whitelist has different semantics), and unresolved checks scope
  to local specifiers — externals stay stub evidence. Evidence is namespaced
  (`provider.dependency-cruiser.*`), advisory and unscored: native graph
  analysis and scoring are untouched, and the report carries only the added
  evidence entry. Conformance and failure-regression suites cover the
  boundary/cycle/unresolved/allowed-import controls, repeat determinism,
  empty-graph and limit failures; the capability table records the adapter
  as delivered (requests resolve per run).
- **Architecture policies describe a bounded declarative dependency-rule
  subset** (trellis-89be, step 21 of 30 of plan `pl-43c5`, SPEC §16.1/§16.4):
  a `dependency-cruiser` request in the `providers` block now carries
  `rules` — inline data only, never an executable `.dependency-cruiser`
  config. Three closed rule kinds: `boundary` (explicit start-anchored
  from/to scope selectors, `forbidden` or `allowed` as an explicit
  exception, over declared runtime/type-only edge kinds), `cycle` (per
  edge kind, keeping type-only and runtime cycle policies distinct) and
  `unresolved`. Unknown kinds/keys, duplicate names or semantics,
  contradictory allowed+forbidden pairs, and unanchored/absolute/
  traversal/uncompileable/over-length patterns are rejected at
  config-load time; rule count and pattern/name lengths are capped
  (bounded evaluation). An absent rules block declares no architecture
  claims — zero rules is never coherence, and nothing is inferred from
  directory names. The pure compilation
  (`src/providers/dependency-cruiser/policy.ts`) normalizes rules into a
  canonical form with a sha-256 digest that rides the §16.2 provider
  options — the existing step-6 compatibility seam — so a changed declared
  architecture is a changed measurement (noncomparable evidence), never
  silently reported as code churn. No adapter yet: requests still resolve
  to located `unsupported` evidence until trellis-adbf delivers.
- **Typed analysis results carry provider provenance and observed coverage**
  (trellis-90d6, step 2 of 30 of plan `pl-43c5`, SPEC §16): new focused
  contracts under `src/contract/` type what a provider analysis is before any
  integration exists — provider identity (id, pinned tool/adapter versions,
  mode, normalized relevant options with machine paths, timestamps and
  durations structurally excluded as execution-only metadata), analysis
  identity (source selection with content fingerprints, parser identity,
  trellis-owned options) with a canonical `measurementIdentity`, observed
  coverage (intended vs. actually analyzed files, diagnostics, unsupported
  context), the five §16.2 states enforced as a structural state matrix where
  empty successful output can never claim `complete`, namespaced external
  evidence ids (`provider.<id>.…`, never colliding with native metrics or
  finding kinds), pair/group clone evidence kept distinct with `near` matches
  pair-only, and a minimum `analysisResultSchema` shared by native and
  external producers. `src/analysis/` adds the internal interfaces that let
  producers carry typed graph/clone products in-process beyond the serialized
  minimum. Contracts only: no report, registry, execution or scoring change;
  native analysis stays the default and authoritative.
- **Offline public-path regression**: real CLI, SDK, and fleet audits run in
  an isolated child with no inherited credentials or executable tools,
  forbidden subprocess/fetch boundaries, and throwing executable target
  configuration. Measurement payloads agree and recursive file snapshots
  prove the workspace and surrounding scratch directory remain unchanged.

### Added

- **Release documentation and portable usage examples reflect the pivot**
  (trellis-7203, SPEC §14 stage 11, stage 21 of the deterministic-pivot plan
  `pl-b2ea`): `README.md` is rewritten for the deterministic sloppiness
  audit — the three invariants, the implemented CLI surface (`audit` /
  `compare` / `fleet` / `report` / `standards` with their real flags), the
  0/1/2 exit-code contract, and portable examples that run with no hosted
  service: local refactor review over saved report artifacts, opt-in
  fleet/history, and a GitHub Actions gate that pins the analyzer version,
  retains the report artifact, and branches exit `2` (policy) from exit `1`
  (operational). The metric catalog and provisional formula weights are
  documented, alongside known limitations (TS/TSX only, no type-3 clones,
  configuration inspection never execution), unsupported-language coverage,
  and migration guidance from readiness reports and configuration.
- **Install/package smoke test** (`bun run smoke:package`,
  `scripts/smoke-package.ts`): packs the tarball with `bun pm pack`, unpacks
  it, and confirms the rubric's retirement did not omit required analyzer
  assets or dependencies — the `trellis` bin entry, the five runtime
  dependencies, the audit core/metrics/syntax/scoring/compare/config/
  contract/safeguards modules plus the bundled standards canonical set —
  then audits a fixture workspace through the packed CLI and validates the
  §6.4 report (schema and analyzer versions, in-range index). Runs offline
  against the repo's own `node_modules`.

### Changed

- **Package metadata and architecture documentation pivoted** (trellis-7203):
  `package.json` description and keywords now describe the deterministic
  TypeScript sloppiness audit (no readiness/rubric wording);
  `docs/architecture.mmd` renders the deterministic module graph
  (discover → parse → measure → score → assemble, with policy/persistence
  outside the measurement pass); `CLAUDE.md`'s module tree reflects the
  current `src/` layout with `rubric/` and `detectors/` marked transitional;
  `RUNBOOK.md` wires `smoke:package` into the release gate, the
  post-publish smoke install (which now audits a fixture, not just boots),
  and the pre-publish checklist.

### Added

- **A fixed TypeScript corpus validates score behavior and performance**
  (trellis-e924, SPEC §14 stage 10, stage 20 of the deterministic-pivot
  plan `pl-b2ea`): `corpus/` holds the committed validation corpus —
  eleven fixture workspaces (the paired refactors clone removal, branch
  growth, cycle introduction, and clean-addition dilution, plus
  small-repo, test-separation, and incomplete-parse singles) and the
  trellis checkout itself — defined by `corpus/manifest.json` with
  explicit per-entry runtime/peak-memory budgets, review checks, and
  paired expectations. `scripts/validate-corpus.ts` audits every entry
  through the same `auditWorkspace` core (no model, no network), measures
  median wall time and peak RSS in fresh child processes, and enforces
  budgets, checks, and pair expectations; `scripts/corpus-report.ts`
  renders the record and `scripts/validate-corpus.test.ts` asserts the
  paired expectations continuously. The measured record — environment,
  revisions, sizes, observations, budgets, paired results, the
  dilution/small-repo/test-separation/incomplete-analysis reviews, and
  the calibration decision — lands in `docs/corpus-validation.md`.
  trellis's own `trellis.yaml` now excludes `corpus/**` from discovery so
  the intentional fixture debt stays out of the dogfood self-audit.

### Changed

- **Duplication minimum clone size calibrated 50 → 100 normalized tokens**
  (trellis-e924, SPEC §5.3): at 50 tokens the corpus and the trellis
  self-audit were dominated by idiomatic-structure matches (78 of 124
  trellis production groups were 50–74 tokens, saturating the duplication
  dimension); at 100 the surviving groups are true copy-paste. Because
  measurement semantics changed, the analyzer version bumps 0.1.0 →
  0.2.0 (stored 0.1.0 reports correctly fail §3.5 comparability). The
  §7.1 scoring constants are unchanged — the corpus showed them producing
  explainable, monotonic, dilution-resistant behavior — so the scoring
  version stays `0.1.0-provisional`. The §5.3 resource budgets
  (`DEFAULT_DUPLICATION_BUDGET`) were confirmed against the measured
  corpus, not changed. Clone test fixtures grew to 105 tokens over 13
  lines at CC 10 so they never leak hotspot findings.

### Added

- **Fleet and history are optional consumers of the deterministic core**
  (trellis-8366, SPEC §10–§11, stage 19 of the deterministic-pivot plan
  `pl-b2ea`): `trellis fleet` now runs every `targets.yaml` target through
  the same `runWorkspaceAudit` service the single-repo CLI and SDK fold —
  each entry of the aggregate `FleetReport` preserves the target's full
  §6.4 report (findings, completeness, metrics) plus the declarative §9
  policy assessment over the target's own `trellis.yaml`, and fleet results
  are proven deep-equal to independent core audits. Canonical-config drift
  rides along per target as a **separate, non-scoring capability**: its
  per-state counts render on the report but never enter the sloppiness
  index, the policy assessment, or the fleet exit rollup (`assessFleet`
  fails exactly when a target errored or tripped its own policy). Fleet
  runs are stateless by default (SPEC §8, §10); `--history` records each
  target's run and surfaces the index move against the repo's previous
  compatible stored run. Legacy targets configuration is rejected with
  actionable migration errors — `defaults.investigation` (the agent pass
  is gone), per-target `skip` (readiness criterion skips) and `languages`
  (detector hints), and the `--fail-on` / `--min-level` / `--no-cache`
  flags (policy is declarative now). `trellis report` renders the
  sloppiness history — a snapshot of each repo's latest audit with the
  index move against the previous §3.5-compatible run, plus per-repo
  compatible index series — with legacy readiness runs preserved in a
  visibly distinct section that is never compared with, averaged into, or
  trended against the sloppiness index (SPEC §10). The SDK's `fleet()` /
  `report()` are direct calls to the same services, with a deep-equal
  CLI⇄SDK fleet parity test. `drift` / `rubric` / `standards` remain the
  transitional legacy surface until the release stages.
- **CLI and SDK expose the same simplified deterministic audit** (trellis-9a88,
  SPEC §12, stage 18 of the deterministic-pivot plan `pl-b2ea`): `trellis
  audit <path>` now folds `runWorkspaceAudit` (`src/audit/run.ts`) —
  configuration (`--config`, else the workspace's `trellis.yaml`) → the
  deterministic core → baseline resolution (`--baseline <report.json>`, else
  the latest compatible stored run when `--history` is on) → declarative
  policy assessment (SPEC §6.5, §9) → opt-in persistence. The default run is
  stateless: no database is opened and no report file is written unless
  `--history` / `--out <file>` ask. The new `trellis compare <a.json>
  <b.json>` compares two saved report artifacts without an audit
  (`runComparison` in `src/compare/run.ts`, terminal/Markdown views in
  `src/report/compare-render.ts`); an incompatible pair fails closed (exit
  2, the comparison still emitted). Retired readiness/investigation flags
  (`--rubric-version`, `--min-level`, `--fail-on`, `--canonical`,
  `--no-persist`, `--output`/`--no-output`, `--no-cache`, `TRELLIS_PI_BIN`)
  fail fast with actionable "removed in the deterministic pivot" errors. The
  SDK's `audit` / `compare` (`src/client/index.ts`) are direct calls to the
  same services, and deep-equal parity tests prove CLI and SDK share one
  measurement and policy code path. `fleet` / `report` / `drift` / `rubric`
  / `standards` remain the transitional legacy surface until trellis-8366.
- **The deterministic audit core assembles the new report** (trellis-ef85,
  SPEC §4, stage 14 of the deterministic-pivot plan `pl-b2ea`):
  `auditWorkspace(root)` in `src/audit/audit.ts` is the one core call that
  audits a TS/TSX workspace end to end — configure → discover → one shared
  parse → measure (complexity, duplication, dependency graph, import
  cycles) → safeguard inspection → the pure provisional score → §6.4 report
  assembly. It runs with no model, network, project-command, Git, or
  database access and writes nothing (persistence and policy evaluation
  stay outside the measurement pass); broad readiness categories, os-eco
  scoring overlays, and the retired Python/Swift detectors are never
  executed on this path. `src/audit/assemble.ts` folds the analysis
  products into the versioned `AuditReport` purely — every analyzer metric
  emitted exactly once (duplicate ids throw), findings grouped by kind with
  analyzer rankings preserved, coverage pairing discovery counts with
  measured sloc — and validates the contract's cross-field honesty
  invariants (completeness rollup, `partial` headline, traceable
  contributions) before a report can leave the core. Progress events
  (`src/audit/progress.ts`) are bounded by the pipeline shape, never by
  repository size. End-to-end fixtures exercise clean, sloppy, mixed-
  language, incomplete (parse failure / unresolved import / budget
  exhaustion), empty, and dirty-worktree repositories over real temporary
  directories, and pin byte-equal measurement payloads per §3.5.
- **The provisional sloppiness formula is explicit and versioned**
  (trellis-00d5, SPEC §7.1, stage 13 of the deterministic-pivot plan
  `pl-b2ea`): `scoreSloppiness(metrics)` in `src/scoring/sloppiness.ts` is
  a pure function of the raw contract metrics — no filesystem, no
  configuration, no safeguard results. Every constant (dimension weights
  0.50/0.30/0.20; per-term saturation thresholds; even in-dimension blends)
  is pinned in `SCORING_FORMULA` (`src/scoring/formula.ts`) under
  `SCORING_VERSION` `0.1.0-provisional`, and the strict audit-config schema
  rejects scoring keys, so policy budgets can never mutate weights. The
  overlapping complexity/erosion/size signals are grouped into one
  `complexity-erosion` dimension (no multiple penalties for the same
  tangle); each dimension blends an absolute-count term beside its density
  term so large clean additions can never dilute hotspot counts (counts
  and densities are both retained, SPEC §3.4). Only the production source
  set is scored — test code never offsets production debt. Missing
  analysis is never zero debt: a dimension whose required metrics are
  `incomplete` or absent scores at full weight and the headline is flagged
  `partial`, while a `not-applicable` ratio with complete zero counts is a
  genuinely empty scope. The index is `clamp(round-half-up(Σ weight ×
  dimension), 0, 100)` over IEEE-754 doubles; reported contributions are
  largest-remainder integer apportionments (ties by dimension id) so they
  sum exactly to the index, and every point traces to raw metric ids,
  values, and thresholds in a deterministic explanation plus the §6.4
  contract `score` view. Fixtures pin the bounds (0 clean / 100
  saturated), lower-is-better monotonicity per raw metric, stable
  rounding, exact contribution totals, the missing-analysis policy, and
  summed-mass (never averaged-ratio) aggregation.
- **Import-cycle measurements expose complete cycle groups** (trellis-cbde,
  SPEC §14 stage 11 of the deterministic-pivot plan `pl-b2ea`):
  `analyzeCycles` in `src/metrics/` consumes the trellis-d214 dependency
  graph and reports **complete cyclic module groups** via strongly
  connected components (iterative Tarjan — never first-cycle-only), under
  the versioned `CYCLE_POLICY` (`1.0.0`). Runtime and type-only edges form
  separate subgraphs and are **scored separately** (a pair linked runtime
  one way and type-only the other is no cycle in either class); self-imports
  are size-1 groups with representative path `[p, p]`. Group ids
  (`cycle-<n>`, assigned in (smallest member, class) order) and
  representative paths (shortest cycle from the smallest member over sorted
  adjacency) are byte-stable across filesystem enumeration order. Package
  views list cross-package groups by shared id while module counts stay
  per-package, so the repo-level affected-module union never
  double-counts. Emits `import-cycle.groups` / `import-cycle.modules` /
  `import-cycle.density` metrics and one located `import-cycle` finding per
  group; unresolved graph coverage accompanies the results — an incomplete
  graph rolls every cycle metric up `incomplete` (SPEC §3.3) with the
  graph's reasons and a machine-readable `unresolvedEdges` count.
- **Workspace-aware import resolution produces a documented dependency graph**
  (trellis-d214, SPEC §14 stage 10 of the deterministic-pivot plan `pl-b2ea`):
  `analyzeDependencyGraph` in `src/metrics/` replaces the regex/relative-only
  graph foundation with AST extraction over the one shared parse (comments,
  string contents, and JSDoc import types cannot forge edges) plus the pinned
  compiler's own module resolution over **local files and configuration
  only** — `node_modules` is never consulted and nothing is ever fetched, so
  absent dependencies change nothing. Edges are typed (`import` /
  `re-export` / `dynamic`; type-only edges — `import type`, `export type …
  from`, type-position `import("…")` — keep their identity) under the
  versioned `GRAPH_POLICY` (`1.0.0`: type-only retained-distinct,
  literal-only dynamic imports, self-edges retained, externals
  recorded-never-resolved). Resolution order: relative (extension
  substitution `.js`→`.ts`, `.mts`/`.cts` mapping, `/index` barrels), then
  the nearest governing `tsconfig.json`'s `paths`/`baseUrl` (undeclared
  `moduleResolution` defaults to `bundler`), then workspace packages by
  manifest name through `exports` (one condition level, single `*` wildcard,
  encapsulation for unlisted subpaths) → `main` → `types` → `index`; anything
  else is an `external` edge recorded by package name. Resolved targets
  outside the classified scope are `out-of-scope` edges; failed local intent
  is `unresolved` with a machine-checkable reason (`no-target`,
  `outside-root`, `exports-encapsulation`, `unsupported-exports`,
  `non-literal-dynamic`) and a located `graph.unresolved-import` finding.
  Emits `graph.files` / `graph.edges.local` / `graph.edges.external` /
  `graph.edges.unresolved` metrics; unresolved edges and parse diagnostics
  roll up `incomplete` (SPEC §3.3) while externals stay `complete` and
  distinguishable. Hand-built fixtures pin aliases, package exports,
  extension mapping, barrels, workspace boundaries, dynamic imports, and
  forgery resistance; two runs over the same tree are byte-equal.

- **Duplication metrics identify clone groups and unique affected lines**
  (trellis-6e4c, SPEC §14 stage 9 of the deterministic-pivot plan `pl-b2ea`):
  `analyzeDuplication` in `src/metrics/` implements the trellis-5a91
  decision (SPEC §5.3) — trellis's own normalized-token clone detector over
  the shared syntax inventory, zero runtime dependencies. Leaf tokens of the
  shared `ts.SourceFile` (identifiers and literals each normalized to one
  placeholder) are sliding-window hashed at 50 tokens and extended into
  maximal matches, grouped by content identity (same-file token-contained
  members dropped, subsumed overlap groups dropped, no transitive merging);
  the provisional minimum is 50 tokens **and** 3 lines per member. Groups
  carry stable `clone-group-<n>` ids after deterministic location sorting.
  The numerator is the union of code-classified lines covered by any member
  (counted once per file) over the scope's code-line denominator, per source
  set — production and test are never matched across sets, and
  generated/vendored/declaration-only/excluded files are never tokenized.
  Declared budgets (2,000,000 tokens, 100,000,000 token comparisons per
  source set) trip `incomplete` with the reason instead of a silent clean
  result. Emits `duplication.groups` / `duplication.duplicated-lines` /
  `duplication.density` metrics per source set and one
  `duplication.clone-group` finding per group. Hand-authored fixtures pin
  exact, renamed, overlapping, multi-copy, below-threshold, near-clone, and
  scope-boundary outcomes.
- **Complexity and structural erosion measurements are reproducible**
  (trellis-fbc5, SPEC §14 stage 7 of the deterministic-pivot plan `pl-b2ea`):
  new `src/metrics/` holds the first deterministic analyzers over the shared
  syntax inventory (SPEC §5.1–5.2). `analyzeComplexity` measures per-function
  cyclomatic complexity (an exact, documented decision table: `if`/`else if`,
  every loop kind, `case` clauses but not `default`, `catch`, ternaries,
  `&&`/`||`/`??` and their logical-assignment forms, and each `?.` token;
  nested functions attributed to themselves via the opaque-leaf walk),
  maximum control-structure nesting, and per-function SLOC (scanner-classified
  code lines over the whole-node range; `src/syntax/sloc.ts` now exposes the
  per-line classification as `classifyLines` so ranges are counted without
  re-scanning). Erosion weights complexity by size (`mass = CC × √SLOC`,
  eroded share = mass of functions with `CC > 10` over total mass);
  aggregation from functions → packages → repo sums masses, never averages
  package shares. Production and test are always measured separately; empty
  scopes yield finite zeros for counts/mass and `not-applicable` for
  distributions and the 0/0 share; scopes with parse diagnostics are
  `incomplete` with partial values. Emits contract `MetricValue`s (ids
  suffixed per source set) and ranked `complexity.hotspot` findings with
  exact paths and line ranges. Hand-calculated fixtures pin branch counts,
  nesting, and weighted erosion.
- **A shared TypeScript syntax and function inventory is available**
  (trellis-d81d, SPEC §14 stage 6 of the deterministic-pivot plan `pl-b2ea`):
  new `src/syntax/` is the one parse layer every metric reuses within an
  audit (SPEC §4, §13). `buildSyntaxInventory` consumes the discovery
  `SourceInventory` and parses each classified TS/TSX file exactly once with
  the now-**pinned** TypeScript compiler API (`dependencies.typescript` is
  the exact `6.0.3` — moved from a floating devDependency; TS 7 dropped the
  JS compiler API, and the inventory records `compilerVersion` for
  traceability). Each `FileSyntax` carries the shared `ts.SourceFile`,
  discovery ownership (`packagePath`/`sourceSet`), a function inventory
  (declarations, expressions, arrows, methods, constructors, get/set
  accessors — with documented naming, 1-based whole-node and body ranges,
  and `depth`/`parentIndex` attribution), scanner-based line counts
  (documented multiline-literal and comment-only handling), and located
  parse diagnostics that roll up to report `completeness` instead of
  throwing (SPEC §3.3). Documented binding rules: overload/`declare`/
  abstract signatures are never inventory entries (they are counted and
  attached to their implementation), and nested function bodies belong to
  the nested function alone — `walkOwnNodes` enforces the attribution
  mechanically so nested branches can never leak into parent totals (§5.1).
  Facts only; scoring stays downstream.
- **TypeScript source discovery produces a classified workspace inventory**
  (trellis-6003, SPEC §14 stage 5 of the deterministic-pivot plan `pl-b2ea`):
  `src/discovery/` gains `discoverSourceInventory` — one deterministic
  filesystem walk (SPEC §3.1) that finds package boundaries from
  `package.json` manifests and workspace declarations (npm/bun/yarn
  `workspaces` array/object, pnpm `pnpm-workspace.yaml` with `!` negation),
  assigns every TS/TSX file (`.ts`/`.tsx`/`.mts`/`.cts`) to exactly one source
  set (production/test/generated/vendored/declaration-only) owned by its
  nearest ancestor package so nested packages are never double-counted, and
  reports — rather than hides — the excluded scope (build outputs
  `dist`/`build`/`out`/`coverage` plus config `source.exclude` globs), the
  unsupported scope (non-TS source files and whole non-TS packages, §3.3),
  and the ignored scope (dependency dirs, dot dirs, symlinked dirs, which are
  never descended into; directory symlinks are never followed so there are no
  cycles). Classification defaults are documented in `classify.ts` with
  explicit §6.5 overrides evaluated before them; matching uses a documented
  minimal glob subset (`*`, `?`, `**`) in `glob.ts`. Discovery works on
  uncommitted files and non-Git trees and never installs packages, runs
  repository scripts, or touches the network. `toSourceCoverage` projects the
  inventory onto the §6.4 report shape (sloc left to the measurement layer).
  New `src/config/` loads and validates the optional `trellis.yaml` /
  `trellis.yml` into the §6.5 audit-config contract (missing file → defaults;
  invalid file → an error naming every offending key). Legacy app discovery
  (`discoverApps`) remains for the transitional rubric path.
- **Versioned §6 contracts land in `src/contract/`** (trellis-58a6, SPEC §14
  stage 4 of the deterministic-pivot plan `pl-b2ea`): zod-validated core types
  and boundary schemas for metric values (unit, numerator/denominator,
  complete/incomplete/unsupported/not-applicable states), located findings,
  safeguard evidence (absent/configured/structurally-wired/unknown), source
  coverage kept distinct from analysis completeness, the audit report
  (raw metrics separate from score contributions; `score.partial` tied to the
  completeness rollup), and the declarative audit configuration (source
  exclusion/classification + failure policy — pure data, no executable hooks,
  no scoring-weight overrides). One `SCHEMA_VERSION` covers the family;
  `ANALYZER_VERSION` aliases the package version and `SCORING_VERSION` pins
  `0.1.0-provisional`. `measurementPayload` strips run metadata (timestamps,
  durations) from equality/fingerprint inputs. Contracts only — analyzers and
  report consumers land with the named downstream issues.

### Fixed

- **Duplication metrics no longer emit a zero denominator** for a scope
  with no code-classified lines (e.g. a repository without test files):
  `duplication.duplicated-lines.<set>` omits the numerator/denominator pair
  there, matching the §6.1 contract (denominators must be positive). The
  audit core's schema validation (trellis-ef85) surfaced the violation.

### Removed

- **The investigation subsystem is deleted** (trellis-4abc, SPEC §14 stage 3 of
  the deterministic-pivot plan `pl-b2ea`). `src/investigation/` (areas, findings
  contracts, grader, Pi RPC provider, frozen goldens) and the live golden
  capture tooling (`scripts/update-pi-golden.ts`) are gone: no executable
  model/provider/agent-grader implementation, prompt, or capture gate remains
  in shipped source or scripts. The store's investigation-cache API
  (`getCache`/`putCache`/`CachedFindings`) is removed; historical migrations
  stay append-only, so the `investigation_cache` table still lands on fresh
  databases and existing user data is untouched — nothing reads or writes it.
- **The os-eco scoring overlay is removed** (SPEC §14 stage 3): the
  `src/detectors/oseco/` evidence pack (dead since the stage-2 disconnect) and
  the `osecoDetectors` toggle on `targets.yaml` targets, `AuditOptions`, and
  the detection context. Strict `targets.yaml` validation now rejects the key.
- **Agent execution is disconnected from every public audit path** (trellis-ba72,
  SPEC §14 stage 2 of the deterministic-pivot plan `pl-b2ea`). The audit
  pipeline, fleet orchestration, CLI, and SDK no longer wire the investigation
  layer: there is no route to Pi or any model from `trellis audit`,
  `trellis fleet`, or the SDK — including the default persistence path (the
  central store is run history only, never an investigation cache). The os-eco
  pass-override overlay is no longer folded into criterion verdicts.
- The 20 agent-discovery criteria — and the all-agent `documentation` category —
  are retired from the transitional rubric catalog: it now totals **70
  deterministic criteria across 8 categories** (rubric `0.3.0`; pre-1.0
  comparability rides the minor slot). Retired criteria no longer count as
  missing measurements or affect the score.

### Changed

- Legacy investigation configuration is **rejected with an actionable error**
  instead of silently honored: the `--no-cache` flag (audit + fleet), the
  `TRELLIS_PI_BIN` environment variable, `targets.yaml`
  `defaults.investigation`, and retired SDK option keys (`noCache`, `piBin`,
  `investigation`, `provider`, `model`) all fail fast naming what to remove.

## [0.1.0] — 2026-06-10

The MVP-complete release — every SPEC §14 milestone has landed — and the first
version published to npm as `@os-eco/trellis-cli` via the version-gated
workflow. No code changes since 0.0.2; this release promotes the finished MVP
surface:

- Six CLI commands (`audit` / `drift` / `fleet` / `report` / `rubric` /
  `standards`) over a single surface-agnostic domain core, mirrored by the
  typed in-process SDK and a CI-usable exit-code contract (`--fail-on`).
- The versioned 9-category / 90-criterion rubric with deterministic detectors
  across three language adapters (TypeScript, Swift, Python) plus os-eco-native
  detectors, app discovery, and §3.4 scoring with the coverage clamp.
- The bounded Pi RPC investigation layer (4 fixed areas, zod-validated
  findings, deterministic grader, offline golden-fixture harness).
- Canonical-config drift against the bundled versioned `standards/` set with
  per-repo allowed deltas, fleet orchestration from `targets.yaml`, and SQLite
  run history with changes-since-last-run reporting.

## [0.0.2] — 2026-06-07

### Added

- Audit progress is now a **single status line that rewrites in place** on an
  interactive (TTY) run (trellis-9b72 second pass): instead of scrolling a line
  per event, one stderr line tracks the current phase plus live progress —
  apps discovered, investigation area `i/total` with the in-flight agent message
  count, and detector `i/total` — cleared by a new `finish()` step before the
  report prints. A non-TTY/CI run stays silent unless `--verbose`, which keeps
  the durable line-per-event log (`src/cli/progress.ts`). `trellis audit` also
  now writes a report file **by default**: a timestamped markdown report under
  `./.trellis/audit-<ts>.md` (run history accrues), with `--output <path>` to
  override path/format and `--no-output` to skip it. stdout always honours
  `--json`/`--md` (default human) so the piping contract is unchanged; a
  `report written to …` note goes to stderr (suppressed by `--quiet`). Enriching
  the default scorecard to a full per-criterion breakdown is tracked separately
  (trellis-89d6).
- Audit run observability + report file export (SPEC §7.3, §12): the audit core
  now emits structured progress events the CLI renders to **stderr**, so a long
  run (the investigation pass can take minutes) is no longer a black box. The
  surface-agnostic core emits the events (`AuditEvent` in `src/report/progress.ts`:
  phase transitions, app/detector counts, and investigation events lifted from
  the Pi RPC loop's `message_end`/`agent_end`/heartbeat/retry signals) and the
  CLI owns rendering them (`src/cli/progress.ts`) — core never logs, keeping the
  api>cli>sdk seam intact. Progress is TTY-aware by default; `--quiet` suppresses
  it and `--verbose` adds per-criterion and per-message detail. `trellis audit`
  also gains `--output <path>`, writing the report to a file (format inferred
  from the `.json`/`.md` extension, overridable by `--json`/`--md`) while stdout
  keeps the readable terminal summary, so the stdout-piping contract is unchanged
  (progress only ever goes to stderr). The `onProgress` sink is a core option on
  `runAudit`, so the SDK's `audit()` mirrors it for free. The agent-criterion →
  scorecard projection helpers moved to `src/report/agent-scope.ts` to keep
  `build.ts` focused on wiring stages together.
- Typed SDK + CI-usable exit-code contract (SPEC §12, §13.1): `src/client/`
  now exposes a typed, in-process SDK — `audit(repoPath, opts)` /
  `drift(repoPath, opts)` / `fleet(targetsPath, opts)` / `report(query)` /
  `rubric()`, plus the `assessReport` / `assessFleet` exit-code rule and the
  `loadRubric` it needs. Each function is a direct call to the same core service
  the CLI folds (the new `runAudit`/`runFleetTargets`/`buildReport` store-lifecycle
  wrappers, `driftRepo`, `summarizeRubric`) with **no logic beyond type shaping**;
  request types mirror the core option types and responses are the core report
  shapes, so a CLI audit and an SDK audit exercise one code path (proven by a
  deep-equal test). Every CLI command now honors an exit-code contract: `0`
  clean, `2` when a `--fail-on` policy trips (the report is still emitted; the
  reason goes to stderr), `1` on an operational error. `--fail-on
  gate|drift|level|none` tunes the gate — the default (flag omitted) fails on a
  gate criterion failing **or** canonical drift; `level` compares the audited
  level against `--min-level` (default `3`). The assessment is surface-agnostic
  core (`src/report/assess.ts`, `src/fleet/assess.ts`) reading the previously
  reserved per-category `gate` flag (a gate fails only when measured and not
  passing); `FleetTargetOk` gains a `gateFailures` count. Golden snapshots of the
  report-JSON and drift-JSON shapes guard surface drift. `EXIT.FAIL = 2` and a
  `FailOnExit` signal land in `src/cli/output.ts`.
- History reporting & changes-since-last-run (SPEC §11, §6.3): a new `trellis
  report [--repo <id>] [--since <date>] [--json|--md]` renders the run-history
  dashboard from the central SQLite store — a fleet snapshot of each repo's
  latest run (level, pass-rate, coverage, net level move), per-repo run series
  over time, and per-criterion trends powered by `criterion_results` (only
  criteria that actually moved). `src/report/changes.ts` computes the §11 delta
  between a run and the repo's most recent prior run: per-criterion transitions
  (`pass-to-fail` / `fail-to-pass` / `na-kind` / `denominator` / `score` /
  `added` / `removed`) plus the net level move, attributed by rubric version —
  identical versions mark a real code regression/improvement (`"code"`),
  differing versions flag the delta as `"possibly-rubric"`. `auditRepo` folds
  this delta into `report.changesSinceLastRun` at audit time when given the prior
  run (`opts.previousRun`); the fleet and single-repo `audit` CLI both read it
  from the history before persisting, so a re-run records its own diff. The store
  gains `repos()` / `runs(repo, since?)` / `criterionTrend(repo, since?)` queries
  and a `storedReport` round-trip. Delta computation, the new store queries, the
  dashboard projection, `--since` filtering, and the terminal/markdown renderers
  are unit-tested; an end-to-end test asserts that after two fleet runs of a
  changed fixture, `trellis report` shows the criterion-level diff with `"code"`
  attribution.
- Pi RPC provider (SPEC §9): `src/investigation/provider/` exposes the single
  core entrypoint `investigate(repoPath, area, opts)` through which all facts are
  produced — both the CLI and SDK reach Pi through it, so the surfaces can never
  disagree. `pi/argv.ts` builds the locked one-shot read-only argv (`--mode rpc
  --no-session --no-extensions -e <findings-extension> --offline
  --no-context-files --provider/--model --tools read,grep,find,ls,submit_findings
  --system-prompt <per-area prompt>`) with §9.4 provider/model precedence (CLI
  flags > `targets.yaml` defaults > a documented constant; provider lowercased).
  `pi/env.ts` does env-passthrough only (never argv): the anthropic base triple
  always, plus the `PI_PROVIDER_ENV_KEYS` map per provider. `pi/findings-extension.ts`
  is the Pi extension that registers `submit_findings`, deriving the tool's
  JSON-schema from the area's zod findings schema via zod v4's native
  `z.toJSONSchema`. `pi/session.ts` is the §9.3 protocol state machine: write one
  prompt and hold stdin open, watch stdout JSONL for the `submit_findings`
  `toolCall`, zod-validate its arguments, close stdin on capture; on a
  missing/invalid call send one corrective prompt echoing the zod errors (bounded
  to N retries, default 2); exhaustion / `stopReason:error` / heartbeat stall /
  process exit resolve `no-detector` with a rationale — never a fabricated pass.
  `pi/version.ts` probes `pi --version` against a documented minimum and degrades
  every agent criterion to `no-detector` (with a hint) when Pi is missing or
  incompatible — it never crashes the audit. All paths (argv, env filtering,
  retry/corrective flow, watchdog, degradation) are unit-tested against a scripted
  fake Pi process with zero network or model access.
- Swift adapter detectors (SPEC §8.3, §14 milestone 4): `src/detectors/lang/swift/`
  binds the §8.3 table's Swift column across four config-first modules
  (`code-quality.ts`, `testing.ts`, `locality.ts`, shared `util.ts`). SwiftLint
  (`.swiftlint.yml` with `disabled_rules`/`only_rules`-aware default-rule
  semantics) drives `lint_config` / `naming_consistency` / `cyclomatic_complexity`;
  swift-format/SwiftFormat → `formatter`; periphery → `dead_code_detection`;
  jscpd → `duplicate_code_detection`; `-warnings-as-errors` in `Package.swift` →
  `strict_typing`; muter → `mutation_testing`. `type_check` (`swift build`) and
  `unit_tests_runnable` / `test_coverage_thresholds` (`swift test
  --enable-code-coverage`) run the toolchain as a subprocess and degrade to
  `no-detector` on exit 127, so CI without a Swift toolchain never false-fails
  (tests stub the process boundary and require no `swift`). Tools are detected
  via config files or a `gatherToolingText` sweep (manifest + Make/Mint/Brew glue
  + CI workflows + `scripts/`). The six concepts Swift lacks
  (`unused_dependencies_detection`, `greppable_exports`,
  `barrel_file_reexport_detection`, `explicit_any_detection`,
  `import_cycle_detection`, and unconfigured `mutation_testing`) resolve to
  `not-applicable` with a rationale naming the language gap (SPEC §8.3), never a
  silent skip. The registry adds the `swift` adapter to each language binding.
- Report renderers + the first end-to-end audit (SPEC §6.3, §14 milestone 3):
  `src/report/` assembles and renders the per-run §6.3 document. `build.ts`'s
  `auditRepo` is the surface-agnostic core pipeline — rubric → app discovery →
  criterion→detector resolution → per-app/-repo detector runs → §3.4 scoring →
  the `Report`. Agent-discovery criteria resolve to `no-detector` (`investigation
  layer not yet wired`, trellis-4222) so coverage honestly reflects the gap;
  unmeasured deterministic criteria flow through the registry's `no-detector`
  stub. The pipeline is deterministic given (checkout, rubric, detector set) —
  the only wall-clock field is `scoredAt` (injectable via `opts.now`), so two
  runs of one checkout serialize byte-identically. Three renderers project the
  report: `json.ts` (`renderJson`, the exact §6.3 document, 2-space indent, the
  determinism anchor), `markdown.ts` (`renderMarkdown`, a PR/issue scorecard),
  and `terminal.ts` (`renderTerminal`, the default human view — level banner,
  app map, fixed-width per-category table, N/A breakdown), all sharing the
  `rollupByCategory` / `tally` folds in `rollup.ts`. `trellis audit <repo-path>`
  (`src/cli/audit.ts`) wires the pipeline end to end behind the global
  `--json` / `--md` flags (`--rubric-version` informational; `--no-cache` /
  `--canonical` accepted for forward-compat; exit `0` until the `--fail-on`
  contract lands in trellis-28a5). Golden-snapshot tests cover the JSON/MD/term
  renderers against a synthetic scorecard, and an integration test audits a
  fixture repo end to end and asserts byte-identical JSON across runs.
  (`trellis-59ea`)

- Scoring engine (the v0 scorer, SPEC §3.4): `src/scoring/` is pure,
  surface-agnostic core with no I/O. `band.ts` maps a fraction to a 20-pt
  maturity band (L1 0–20% … L5 80–100%, lower-bound inclusive) and `clampLevel`
  takes the monotonic coverage clamp (`min`, only ever lowers). `entry.ts`
  defines the §6.2 `ScorecardEntry` (numerator/denominator/rationale/naKind), a
  zod schema enforcing the numerator↔naKind biconditional and ≤500-char
  rationale, and the `disposition`/`perCriterionScore` classifiers. `score.ts`'s
  `scoreRun` folds a run's scorecard over the rubric universe into `passRate`
  (mean over counted criteria, N/A excluded), `coverage`
  (`counted / (counted + no-detector + skipped)`, `not-applicable` excluded),
  and the clamped `level`, with a counts breakdown. `aggregate.ts` rolls raw
  outcomes into entries: repo-scope denominator always `1`, app-scope
  `numerator = passing apps` / `denominator = N`, collapsing all-N/A apps to the
  right naKind. `gate`/`weight` stay reserved and unread (SPEC §3.3).
  (`trellis-92f6`)

- CLI skeleton + first end-to-end command (SPEC §12, §13.1, §14.1): `src/cli/`
  is a thin commander surface that parses args, calls the domain core, and
  shapes output only. `src/cli/main.ts` registers the SPEC §12 command set
  (`audit`/`drift`/`fleet`/`report`/`standards` are stubs until their milestone
  lands) with global `--json` / `--md` flags (human terminal output by default);
  `src/cli/output.ts` carries the format resolution, `emit`, exit-code scaffold
  (`EXIT`), and `CliError`/`renderError` for consistent failure rendering;
  `src/cli/logger.ts` initializes a pino logger to stderr (`TRELLIS_LOG_LEVEL`,
  default `warn`) so payloads on stdout stay machine-clean. The first real
  command, `trellis rubric` (`src/cli/rubric.ts`), prints the loaded rubric
  summary — per-category criterion counts, repo/app split, level histogram, gate
  id — plus `RUBRIC_VERSION`; `trellis rubric --validate` runs the loader
  invariants and exits non-zero with a precise `id`/`file` error on violation.
  The summary fold lives in the core as `summarizeRubric` (`src/rubric/summary.ts`).
  (`trellis-0b7c`)

- Rubric core (the WHAT layer, SPEC §6.1): `src/rubric/schema.ts` zod schemas
  for category and criterion records (snake_case ids, `level` 1–5, `scope`
  repo/app, `discoveryVia` deterministic/agent, the four fixed `investigation`
  areas, reserved `gate`/`weight` with defaults), `src/rubric/version.ts`
  exporting `RUBRIC_VERSION = "0.2.0"` plus a `comparable()` helper encoding the
  SPEC §3.5 semver-by-comparability policy, and `src/rubric/loader.ts`
  (`loadRubric`) which parses `categories.yaml` / `repo-scope.yaml` /
  `app-scope.yaml` and enforces the load-time invariants — investigation
  non-null IFF `discoveryVia: agent`, scope matches source file, ids unique,
  category references resolve, exactly one `gate: true` per category — throwing
  `RubricError` with the offending id and file. (`trellis-2304`)
- `.github/` governance & CI surface: `dependabot.yml` (cooldown / delayed
  adoption), issue templates (`bug_report`, `feature_request`, `config`),
  `pull_request_template.md`, `labels.yml`, and workflows `ci.yml`
  (verbatim `check:all` parity with the local gate + `test:ci`, report
  summaries, and JUnit/lcov artifact uploads), `sync-labels.yml`,
  `publish.yml` (version-gated `@os-eco/trellis-cli` publish with provenance
  and `package.json` ↔ `src/index.ts` VERSION-sync assertion), and
  `auto-merge.yml`. Adds `report:test-timing` / `report:quality-metrics`
  package scripts the CI report steps invoke. (`trellis-7baf`)
- Governance & agent-instruction surface: `README.md`, `AGENTS.md`,
  `CLAUDE.md`, `CHANGELOG.md`, `CODEOWNERS`, `CONTRIBUTING.md`, `SECURITY.md`,
  `RUNBOOK.md`, `docs/architecture.mmd`, and `.claude/commands/`
  (`release`, `pr-reviews`, `issue-reviews`, `prioritize`). (`trellis-03a9`)
- `package.json` quality-gate script wiring (`check:*` family, `test:ci`,
  `prepare`); the backing ratchet scripts and budgets land with the L5 toolkit.
  (`trellis-03a9`)
- Bun + TypeScript-strict skeleton, os-eco baseline configs, and the `src/`
  module tree per SPEC §4. (`trellis-b636`)
