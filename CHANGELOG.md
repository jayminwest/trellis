# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While pre-1.0, breaking changes go in MINOR and additive changes go in PATCH.

## [Unreleased]

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
