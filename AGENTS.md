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

> **Breaking pivot in progress (plan `pl-b2ea`, SPEC §14).** trellis replaces
> the retired 90-criterion agent-readiness product (rubric, maturity levels,
> LLM investigation layer). The `src/` tree is mid-transition: legacy modules
> (`src/rubric/`, the per-language detector adapters) remain operative until
> the staged plan removes or replaces them; the investigation subsystem was
> deleted in stage 3 (trellis-4abc). Legacy
> readiness scores are preserved in history as a separate quantity and are
> never compared with the sloppiness index.

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

trellis ships a CLI (`trellis`, bin `./src/cli/main.ts`). The current
transitional subcommands (SPEC §14; the target surface is SPEC §12):

```bash
trellis audit <path>          # measure + score; print the §6.4 report
                              #   [--baseline r.json] [--config t.yaml] [--history] [--out f]
trellis compare <a> <b>       # compare two saved audit reports (no audit)
trellis drift <repo-path>     # L1 canonical-config drift only (legacy surface)
trellis fleet                 # audit every target in targets.yaml (legacy surface)
trellis report                # render history/dashboard from SQLite (legacy surface)
trellis rubric [--validate]   # print the loaded rubric (legacy surface)
trellis standards             # show canonical manifest + versions
```

`audit` and `compare` are the deterministic surface (trellis-9a88); the rest
still wrap the legacy readiness core until trellis-8366 adapts them. The
default audit is stateless — no database without `--history`, no report file
without `--out` — and retired readiness-era flags (`--fail-on`, `--min-level`,
`--rubric-version`, `--no-persist`, provider/cache knobs, …) fail with an
actionable "removed in the deterministic pivot" error.

`--json` / `--md` switch terminal output to machine/report shapes.

### Exit codes (SPEC §9)

Every command exits `0` clean, `2` when a failure policy trips (the report
is still emitted to stdout; the reason goes to stderr), or `1` on an operational
error (the command could not run). On the deterministic surface the policy is
declarative in `trellis.yaml` (SPEC §6.5: `maxIndex`, metric `budgets`,
baseline `regression`, `failOnNew`) and evaluated by `assessPolicy` in
`src/compare/policy.ts`; `trellis compare` exits `2` when the artifact pair is
not comparable. The legacy commands keep the transitional `--fail-on
gate|drift|level|none` policy (`assessReport` in `src/report/assess.ts`,
`assessFleet` in `src/fleet/assess.ts`) until trellis-8366. `EXIT` lives in
`src/cli/output.ts`; the assessment is core, so the CLI and SDK gate
identically.

### Programmatic SDK (`src/client/`)

`src/client/index.ts` exposes `audit` / `compare` (the deterministic surface)
plus `drift` / `fleet` / `report` / `rubric` (legacy, until trellis-8366) and
the `assessPolicy` / `assessReport` / `assessFleet` exit-code rules. Each is a
direct call to the same core service the CLI folds (`runWorkspaceAudit`,
`compareArtifacts`, `driftRepo`, `runFleetTargets`, `buildReport`,
`summarizeRubric`) — **no logic beyond type shaping**. Request types mirror
the core option types (`// Mirrors src/<x>`); responses are the core report
shapes. The deep-equal test in `src/client/index.test.ts` proves a CLI audit
and an SDK audit are one measurement and policy code path.

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

- All behavior lives in the **core** modules under `src/` (transitional set:
  `src/audit/`, `src/rubric/`, `src/discovery/`, `src/syntax/`, `src/detectors/`,
  `src/scoring/`, `src/standards/`, `src/fleet/`, `src/store/`, `src/report/`;
  the target layout is SPEC §4). No business logic anywhere else.
  `src/audit/` is the deterministic audit core (trellis-ef85):
  `auditWorkspace(root)` runs discover → parse → measure → safeguards →
  score → assemble and returns the versioned §6.4 `AuditReport`, with no
  model, network, project-command, Git, or database access.
- `src/cli/` is a **thin** commander pass-through; `src/client/` is a typed
  SDK whose types **mirror the core** (annotate `// Mirrors src/<x>`). Both
  call the same core functions so a programmatic audit and a CLI audit
  exercise one code path.
- The pivoted seam: deterministic analyzers over one shared syntax inventory;
  scoring is a pure function of raw metrics; safeguards never enter the
  score. Keep that seam clean.

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

The pino logger must redact sensitive keys (`token`, `api_key`, `password`,
`secret`, `authorization`, `set-cookie`). Add new redact paths in the same
commit that introduces a new sensitive field.

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

Once the deterministic core lands (SPEC §14), trellis audits itself:
`trellis audit .` runs offline with no model, and a regression in trellis's
own sloppiness index is a real failure. (The retired "band L4+ against the
readiness rubric" gate went with the rubric.)

## Further reading

- [`SPEC.md`](SPEC.md) — the deterministic product contract (authoritative)
- [`README.md`](README.md) — user-facing pitch + install
- [`CLAUDE.md`](CLAUDE.md) — tool-specific conventions for agents
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`RUNBOOK.md`](RUNBOOK.md) — release / triage / rollback procedure
- [`docs/architecture.mmd`](docs/architecture.mmd) — module graph (pre-pivot;
  refreshed with the release docs stage, SPEC §14)
- `scripts/` — ratchet scripts and pre-commit hook (lands with `trellis-4ec4`)
- `.github/workflows/` — CI + sync-labels + publish (lands with `trellis-7baf`)
