# AGENTS.md

This file is the canonical entry point for AI coding agents working in
`trellis`, following the [agents.md](https://agents.md) convention. For the
full design record see [`SPEC.md`](SPEC.md); for ecosystem context see
[`CLAUDE.md`](CLAUDE.md).

## Mission

`trellis` — a **deterministic, offline-by-default sloppiness audit** for
TypeScript/TSX workspaces. It parses source with the TypeScript compiler API
and measures structural debt — **complexity, structural erosion, duplication,
and import cycles** — plus a separate, non-scoring inspection of safeguard
configuration (hooks and check wiring). Each run emits a versioned report
with a **0–100 sloppiness index where lower is better** (not a percentage of
bad code; infrastructure cannot offset it), raw metrics, traceable score
contributions, ranked hotspots, and safeguard evidence.

Three invariants define the product (SPEC §1):

1. **No-model execution.** No audit path — CLI, SDK, fleet, or CI — spawns an
   agent, calls a model, or consumes model-derived grading.
2. **Offline and zero-footprint by default.** The first audit needs neither
   Git nor credentials, a database, network, or installed project
   dependencies; it writes nothing unless the operator asks.
3. **One core, every surface.** Local, fleet, and CI runs exercise the same
   deterministic core; CLI and SDK are thin pass-throughs.

> **Deterministic pivot delivered (plan `pl-b2ea`, SPEC §14).** Public
> readiness catalog and assessment APIs are retired. Internal legacy modules
> remain for historical report compatibility and regression fixtures; they
> are not used by the audit, compare, fleet, or history surfaces. Legacy
> readiness scores are preserved separately and never compared with the
> sloppiness index. See [`docs/release-acceptance.md`](docs/release-acceptance.md).

> **Planned successor: optional quality-evidence providers (plan `pl-43c5`,
> SPEC §16 — contract only, nothing implemented yet).** Pinned local
> analysis tools (jscpd, dependency-cruiser, Knip; SonarJS gated) may run
> as **explicitly opt-in, supplemental, unscored evidence** behind
> trellis-owned controls. The contract revises the shared-parser and
> subprocess restrictions for those optional slots without weakening the
> no-model, no-target-command, no-audit-time-download or default-offline
> guarantees. Native analysis stays the default and the authoritative
> scoring basis; steps `trellis-90d6` onward own delivery.

trellis is part of [os-eco](https://github.com/jayminwest/os-eco), the AI agent
tooling ecosystem. It is the **measurement surface**: it gives the fleet an
objective, reproducible read on structural code health. trellis mirrors the
warren/burrow Bun + TypeScript-strict + Biome + SQLite stack and dogfoods its
own audit (SPEC §14).

## Commands

All commands run from the repo root unless noted. `Bun` must be on PATH.

```bash
bun install                   # install dependencies
bun test                      # run all tests
bun test <path/to/file>       # run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run lint:fix              # biome check --write --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run check:all             # full quality-gate suite (see below)
bun run verify                # alias for check:all (agent-facing entry point)
bun run check:coverage        # tests + coverage ratchet
bun run test:ci               # bun test with junit + coverage reporters
```

trellis ships a CLI (`trellis`, bin `./src/cli/main.ts`). The deterministic
surface (SPEC §12) includes optional fleet/history and separate canonical
standards/drift inspection:

```bash
trellis audit <path>          # measure + score one workspace; print the sloppiness report
                              #   [--json|--md] [--out <file>] [--baseline <report.json>]
                              #   [--config <file>] [--history] [--db <path>]
trellis compare <a> <b>       # compare two saved report artifacts (no audit)
trellis fleet                 # audit every target in targets.yaml through the same core
                              #   [--history] [--db <path>] (drift rides along, never scored)
trellis report                # sloppiness history from SQLite; legacy readiness kept distinct
trellis drift <repo-path>     # canonical-config drift only (separate, unscored)
trellis standards             # show canonical manifest + versions
```

`--json` / `--md` switch terminal output to machine/report shapes. The
default `audit` run is **stateless** — no database, no report files — unless
`--history` / `--out` ask. Retired readiness/investigation flags
(`--fail-on`, `--min-level`, `--rubric-version`, `--no-persist`, `--output`,
`--no-cache`, …) fail fast with actionable "removed in the deterministic
pivot" errors.

### Exit codes (SPEC §9)

Every command exits `0` clean, `2` when a policy trips (the report is still
emitted to stdout; the reason goes to stderr), or `1` on an operational
error (the command could not run). On the deterministic surface the policy
is **declarative**: the policy block of the workspace's trellis.yaml (SPEC §6.5 — max
index, metric budgets, score regression, new-finding kinds) gates `audit`
and `compare`, and an incompatible `compare` pair fails closed. `EXIT`
lives in `src/cli/output.ts`; the assessment is core (`assessPolicy` in
`src/compare/policy.ts`), so the CLI and SDK gate identically. `fleet`
gates on each target's own declarative policy result plus per-target
operational failures (`assessFleet` in `src/fleet/assess.ts`); canonical
drift rides along as a separate, non-scoring capability and never gates.
The separate `drift` command retains `--fail-on drift|none` for canonical
configuration policy.

### Programmatic SDK (`src/client/`)

`src/client/index.ts` exposes `audit` / `compare` / `fleet` / `report` over
the deterministic core plus separate `drift` and the
`assessPolicy` / `assessFleet` exit-code rules. Each is a
direct call to the same core service the CLI folds (`runWorkspaceAudit`,
`runComparison`, `driftRepo`, `runFleetTargets`, `buildReport`) — **no logic beyond type shaping**. Request types mirror
the core option types (`// Mirrors src/<x>`); responses are the core report
shapes. The deep-equal tests in `src/client/index.test.ts` prove a CLI
audit/compare/fleet and an SDK audit/compare/fleet are one code path —
measurement and policy alike.

### Quality gates

`bun run check:all` (alias `bun run verify`) is the canonical quiet runner
`scripts/check-all.ts` — byte-identical across the os-eco fleet (see the
os-eco meta-repo's `docs/check-all-standard.md`, the same standard trellis's
own audit checks for). Never edit it in place; per-repo variation lives in
`package.json` script bodies. It runs the nine core gates in canonical order:

- `lint` — `biome check --error-on-warnings .`
- `typecheck` — `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, no `any`)
- `check:agents` — `scripts/validate-agents-md.ts` (this file's references)
- `check:dups` — `bunx jscpd` (duplicate-code detector)
- `check:deps` — `knip --dependencies` (unused / undeclared deps)
- `check:size` — `scripts/check-file-sizes.ts` (line-count ratchet)
- `check:debt` — `scripts/check-debt-markers.ts` (tracker-pinned TODOs)
- `check:coverage` — `scripts/check-coverage.ts` (per-package floors)
- `check:ci-parity` — `scripts/check-ci-parity.ts` (CI ⇄ check:all parity;
  escape hatches in `scripts/ci-parity-config.json`)

The ratchet scripts and their JSON budgets land with the L5 quality toolkit
(seeds `trellis-4ec4`). Budgets ratchet in one direction only (file-size and
debt-markers tighten downward; coverage tightens upward). Do not loosen a
budget without filing `trellis-XXXX` and noting it in the commit body.

## Conventions

### Filenames & directories

- Source files: kebab-case `*.ts`. Tests are `<name>.test.ts` next to the file
  under test.
- Directories: `kebab-case`.
- Golden fixtures live under `__golden__/`. Regenerate only via a documented
  update gate, never by hand.
- YAML config keys (audit configuration, `targets.yaml`) stay in the schema's
  casing.

Enforced by Biome's `style.useFilenamingConvention` rule in `biome.json`.

### Identifiers

- `camelCase` for functions, variables, instance fields.
- `PascalCase` for types, interfaces, classes.
- `SCREAMING_SNAKE_CASE` for module-level true constants (`VERSION`).
- Booleans read as predicates: `isSkippable`, `hasDetector`.

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible
  `undefined` from indexing.
- No `any`; use `unknown` and narrow (zod at every external boundary).
- Import with `.ts` extensions.
- Tab indentation, 100-char line width (Biome enforces).

### Architecture discipline (api>cli>sdk, SPEC §13.1)

- All behavior lives in the **core** modules under `src/` (current core:
  `src/audit/`, `src/rubric/`, `src/discovery/`, `src/syntax/`, `src/detectors/`,
  `src/scoring/`, `src/standards/`, `src/fleet/`, `src/store/`, `src/report/`,
  `src/providers/`;
  the target layout is SPEC §4). No business logic anywhere else.
  `src/audit/` is the deterministic audit core (trellis-ef85):
  `auditWorkspace(root)` runs discover → parse → measure → safeguards →
  score → assemble and returns the versioned §6.4 `AuditReport`, with no
  model, network, project-command, Git, or database access.
  `runWorkspaceAudit(root)` (trellis-9a88) is the service the surfaces fold:
  it composes configuration, the pure pass, baseline resolution, policy
  assessment (`src/compare/`), and opt-in history (`src/store/`) around the
  measurement — never inside it.
- `src/cli/` is a **thin** commander pass-through; `src/client/` is a typed
  SDK whose types **mirror the core** (annotate `// Mirrors src/<x>`). Both
  call the same core functions so a programmatic audit and a CLI audit
  exercise one code path.
- The pivoted seam: deterministic analyzers over one shared syntax inventory;
  scoring is a pure function of raw metrics; safeguards never enter the
  score. Keep that seam clean. The planned provider seam (SPEC §16, plan
  `pl-43c5`) keeps native analyzers and their shared inventory authoritative
  while optional pinned providers contribute unscored evidence through
  controlled execution — never through the shared inventory or the score.

### Provider evidence contract (planned — SPEC §16)

The full contract is SPEC §16 (integration contract for plan `pl-43c5`);
the digest for agents working in this repo:

- **Native is default and authoritative.** Optional providers are
  supplemental in this delivery; provider observations are unscored,
  namespaced evidence. Backend promotion or provider-derived weights need a
  separately versioned calibration — never the current scoring version.
- **Identity and states.** Every provider result carries provider identity
  (id, pinned tool version, adapter version, mode/options), analysis
  identity (input snapshot + provider parser/version) and asserted observed
  coverage — never exit-status-inferred. Allowed states: `unrequested`,
  `unavailable`, `unsupported`, `incomplete`, `complete`. No zero-valued
  metrics are invented for absent execution.
- **Failure semantics.** A requested provider that fails is located
  `unavailable`/`incomplete` evidence; a violated declarative requirement
  on it trips policy (exit `2`). Invalid provider configuration or
  inability to run the audit stays operational error (exit `1`). Advisory
  failure is visible evidence, not an abort.
- **Execution boundary.** Default native audits create no scratch files.
  Explicitly enabled external execution may use trellis-owned isolated
  temporary storage with cleanup and never writes to the target. No target
  scripts, executable target configuration, arbitrary command strings,
  audit-time downloads, or models — ever. The controlled process runner
  (`src/providers/process.ts`, trellis-eddc) is the only seam that may
  start a provider subprocess: fixed `argv`, supported executables only,
  explicit environment, wall-time/output limits, process-group
  termination, scrubbed diagnostics — no shell, no success claims. The
  staging layer (`src/providers/workspace.ts` with `src/providers/staging.ts`,
  `src/providers/context.ts` and `src/providers/staged-run.ts`, trellis-2fe6)
  builds the isolated view
  that seam consumes: a content-fingerprinted, classified source snapshot
  with opt-in declarative project context, realpath-validated containment
  (no symlink/traversal escapes, canonical paths) and owned scratch cleanup
  on every exit path — native audits never invoke it. The supported-tool
  manifest/resolver (`src/providers/manifest.ts` + `src/providers/resolve.ts`,
  trellis-ff52; see [`docs/provider-tools.md`](docs/provider-tools.md)) pins
  the exact external artifacts (initially jscpd 5.2.1, an isolated
  devDependency) and resolves them only from an operator-prepared local
  installation — verified against recorded digests before use, never via
  PATH/bunx, never installed or downloaded at audit time.
- **Compatibility.** Provider changes never fragment score history; provider
  evidence compares only on identical provider/analysis identity; older
  artifacts without provider evidence read as `unrequested`, never as
  regressions.
- **Sonar gate.** SonarJS requires an affirmative documented
  distribution/metric-interface decision; until then it is explicitly
  deferred — a valid request resolves to `unsupported` with the reason,
  visible and policy-testable, never claimed implementation. The decision
  is recorded as **deferred** in
  [`docs/sonarjs-decision.md`](docs/sonarjs-decision.md) (trellis-db3e)
  and carried by the typed capability metadata in
  `src/providers/capabilities.ts`; the clearance prerequisite is tracked
  as `trellis-7f5d`.

### Test naming

- `describe("<unitUnderTest>")` + `test("verb-led behaviour description")`.
- No `should`, no `it`.
- No mocks for filesystem or SQLite — use temp dirs and `:memory:`/temp DBs.
  Stub only at true external process boundaries; the layers above run real
  code paths against golden fixtures.

### Debt markers

Every `TODO` / `FIXME` / `HACK` / `XXX` on a source line must carry a tracker
reference on the same line. Accepted prefixes:

- `trellis-XXXX` — repo-local seeds tracker
- `mx-XXXX` — cross-repo mission tracker
- `#NNN` — GitHub issue
- A URL (any http link) — external reference

`scripts/check-debt-markers.ts` fails CI on bare markers.

### Log scrubbing

CLI progress and errors write to stderr. Never include sensitive fields
(`token`, `api_key`, `password`, `secret`, `authorization`, `set-cookie`) in
diagnostics. Any future structured logger must redact those keys.

## Agent Workflow

When an agent works in `trellis`, it should:

1. **Prime context.** Read this file (`AGENTS.md`), `SPEC.md` for the area
   under change, and the most recent `CHANGELOG.md` entry. Run `ml prime` and
   `sd prime` (os-eco session bootstrap).
2. **Find unblocked work.** `sd ready` (Seeds) or `gh issue list`.
3. **Make focused changes.** One concern per commit. Preserve existing
   conventions — adapt, don't overwrite. Respect the api>cli>sdk seam.
4. **Run gates locally.** `bun run lint && bun run typecheck && bun test &&
   bun run check:all` must all exit 0 before commit.
5. **Pin debt markers.** Any new `TODO` / `FIXME` must reference a tracker id
   created in the same change.
6. **Commit & sync.** Commit message follows `<area>: <summary>` (e.g.
   `metrics: cap nesting contribution at package boundary`).
7. **Record insights.** `ml record <domain> --type <type>` for any convention
   discovered, pattern applied, or failure encountered.

### Session completion protocol

Before ending a session:

1. File issues for remaining work (`sd create`).
2. Run `bun run check:all`.
3. Close finished issues (`sd close <id>`).
4. Record session insights (`ml record` / `ml sync`).
5. Push only when the user requests it; otherwise leave commits local.
6. Verify `git status` is clean.

## Testing & Validation Guidance

### Per-change verification

After every code change (before commit):

```bash
bun run lint
bun run typecheck
bun test
bun run check:all
```

All must exit 0. CI runs the same suite — local greens are the contract.

### Coverage discipline

`bun run check:coverage` enforces `scripts/coverage-budgets.json`. The ratchet
only goes **up**. Raising a floor when coverage improves is encouraged;
lowering one requires a `trellis-XXXX` in the commit body explaining what tests
were removed and why.

### Tests live beside the unit

`bunfig.toml` sets the test root to `src`. New tests belong next to the file
under test as `<name>.test.ts`. Golden-fixture suites read from `__golden__/`
and must pass with no network.

### CI parity

`.github/workflows/ci.yml` runs `bun run check:all` and uploads
`coverage/lcov.info` and `junit.xml`. Local `check:all` failures will break CI;
do not push hoping CI will pass. The `check:ci-parity` gate enforces this
mechanically: every `bun run <x>` in `ci*.yml` must be reachable from the
`check:all` manifest, or carry a justified entry in
`scripts/ci-parity-config.json` (`test:ci` aliases to `check:coverage`; the
`report:*` summaries are CI-only).

### Dogfood

trellis audits itself (SPEC §14):
`trellis audit .` runs offline with no model, and a regression in trellis's
own sloppiness index is a real failure. (The retired "band L4+ against the
readiness rubric" gate went with the rubric.)

## Further reading

- [`SPEC.md`](SPEC.md) — the deterministic product contract (authoritative)
- [`README.md`](README.md) — user-facing pitch + install
- [`CLAUDE.md`](CLAUDE.md) — tool-specific conventions for agents
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`RUNBOOK.md`](RUNBOOK.md) — release / triage / rollback procedure
- [`docs/architecture.mmd`](docs/architecture.mmd) — module graph of the
  deterministic core (SPEC §4)
- [`docs/corpus-validation.md`](docs/corpus-validation.md) — the fixed-corpus
  validation record (trellis-e924): score-behavior evidence, runtime/memory
  budgets, and the duplication-minimum calibration; corpus lives in
  [`corpus/`](corpus/README.md), harness in `scripts/validate-corpus.ts`
- [`docs/research/provider-spike.md`](docs/research/provider-spike.md) — the
  fixed-corpus provider research (jscpd/SonarJS/dependency-cruiser/Knip)
  behind the SPEC §16 optional-provider contract
- [`docs/provider-tools.md`](docs/provider-tools.md) — the pinned
  supported-tool manifest and local resolver: operator-prepared
  installation, artifact verification, honest platform records, and
  upgrade/identity rules (trellis-ff52)
- `scripts/` — ratchet scripts and pre-commit hook (lands with `trellis-4ec4`)
- `.github/workflows/` — CI + sync-labels + publish (lands with `trellis-7baf`)
