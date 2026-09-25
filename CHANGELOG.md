# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While pre-1.0, breaking changes go in MINOR and additive changes go in PATCH.

## [Unreleased]

### Fixed

- A non-literal dynamic `import(expr)` no longer marks the whole dependency
  graph incomplete and charges the full import-cycle dimension. Graph policy
  1.1.0 records such sites as opaque: the unresolved edge, finding and a
  `nonLiteralDynamic` count stay visible, while cycle metrics over the literal
  graph stay complete. Other unresolved edges still degrade as before; scoring
  weights are unchanged (trellis-42ad).
- Imports of workspace packages in unbuilt monorepos now resolve to source.
  `exports` lookup accepts fallback arrays and nested conditions, honours
  tsconfig `customConditions` and source-named conditions (`source`,
  `@scope/source`), and maps entries naming absent `dist/` output back to
  source via the package tsconfig `outDir`→`rootDir` or the `dist|build|lib|out`
  →`src` convention. No build is ever run; a fresh zod clone drops from 108 to 2
  unresolved `no-target` edges (trellis-a98b).
- Native duplication tokens no longer include JSDoc comments or empty
  syntax-list leaves, matching SPEC §5.3. Thresholds and scoring are
  unchanged; the trellis self-audit moves 41 → 40 and every corpus fixture
  keeps its index (see `docs/corpus-validation.md`, trellis-57aa).

## [0.3.0] — 2026-09-19

### Added

- Native clone findings now include versioned same-file line-overlap facts,
  affected member indexes and shared spans. Terminal and Markdown reports
  flag overlapping matches for review; older reports retain unknown overlap
  status. Cleanup guidance emphasizes responsibility and readability over score
  reduction alone. Clone findings, metrics and scoring stay unchanged (trellis-8a72).
- Native hotspots now carry scoped function identity or an explicit ambiguity
  reason, derived from the shared AST (trellis-3d6b). Analyzer 0.2.2 and schema
  1.2.0 preserve native metrics and scoring. Historical 1.0.0/1.1.0 reports
  remain readable; comparisons across the identity transition require a fresh
  baseline. Scoped matching now preserves unchanged named hotspots after line
  shifts and distinguishes replacements and same-named methods in different
  classes; ambiguous identities retain all new/resolved occurrences (trellis-7cfd).
  Saved-baseline policy, CLI/SDK, fleet and SQLite regressions verify this
  identity milestone without changing native scores (trellis-61d7).
- Combined scoped-hotspot and forty-copy clone acceptance now covers saved
  baselines, policy, CLI/SDK, fleet and SQLite without changing native scores
  on formerly complete inputs (trellis-12c1). Evidence:
  `docs/scoped-identity-duplication-acceptance.md`.
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

### Changed

- Analyzer **0.3.0**: the analyzer version follows the package version, and
  comparisons fail closed across analyzer versions. Reports saved by 0.2.3 or
  earlier remain readable; comparing against them requires a fresh baseline.
  Schema 1.2.0 and scoring 0.2.0-provisional are unchanged.
- Analyzer **0.2.3** promotes the parity-validated SA-IS/LCP native duplication
  engine (trellis-e55c). Forty-copy, pinned Hono and Zod duplication now complete
  within frozen work/time/RSS bounds. Token normalization, 100-token/3-line
  thresholds, group/line semantics, schema 1.2.0 and the scoring formula remain
  unchanged. `maxMatchWork` now explicitly counts whole-pipeline work (v2);
  exhaustion is located and unmeasured, never fabricated zero debt. The old
  quadratic engine exists only in test references. Historical artifacts remain
  readable; analyzer/resource transitions require a fresh baseline. No provider
  promotion, runtime dependency, model, network or default write is introduced.
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
- **Duplication metrics no longer emit a zero denominator** for a scope
  with no code-classified lines (e.g. a repository without test files):
  `duplication.duplicated-lines.<set>` omits the numerator/denominator pair
  there, matching the §6.1 contract (denominators must be positive). The
  audit core's schema validation (trellis-ef85) surfaced the violation.

### Removed

- Simplified the package to the deterministic audit, its reports and opt-in
  history. Removed unused analysis paths and refreshed contributor, CLI and
  architecture guidance (trellis-ddf5, trellis-46db, trellis-57b1).
- **Breaking:** the hidden retirement shims are gone. `trellis rubric` and the
  retired `audit` flags (`--no-cache`, `--no-persist`, `--output`/`--no-output`,
  `--fail-on`, `--min-level`, `--canonical`, `--rubric-dir`, `--rubric-version`)
  now fail as unknown commands/options instead of printing retirement guidance,
  and `trellis report` / SDK `report` no longer show legacy readiness history.
  Existing audit records are preserved.
