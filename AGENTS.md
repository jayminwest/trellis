# AGENTS.md

This file is the canonical entry point for AI coding agents working in
`trellis`, following the [agents.md](https://agents.md) convention. For the
full design record see [`SPEC.md`](SPEC.md); for ecosystem context see
[`CLAUDE.md`](CLAUDE.md).

## Mission

`trellis` — a mostly-deterministic, partly-agentic audit tool that keeps a
fleet of repositories in sync on *agent-readiness*: how legible and verifiable
a repo is to a non-human collaborator. A repo is scored 0–100% across a
versioned, 9-category / 90-criterion rubric, mapped to a maturity Level 1–5,
and its score history is tracked centrally so drift surfaces over time. ~78%
of criteria are deterministic file/config/command checks; the rest are decided
by a deterministic grader consuming objective facts gathered by a bounded LLM
investigation pass. trellis also detects **canonical-config drift** — it
compares a repo's shared tooling files against a bundled, versioned
`src/standards/` set, honoring per-repo allowed deltas.

trellis is part of [os-eco](https://github.com/jayminwest/os-eco), the AI agent
tooling ecosystem. It is the **measurement surface**: it grades the very
properties the rest of the toolchain (warren, seeds, mulch, canopy, …) is built
to provide. trellis is stack-agnostic by design but stack-first in practice —
it mirrors the warren/burrow Bun + TypeScript-strict + Biome + SQLite stack and
should score L4+ against itself (eat-its-own-dogfood, SPEC §13).

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

trellis ships a CLI (`trellis`, bin `./src/cli/main.ts`). The six MVP
subcommands (SPEC §12):

```bash
trellis audit <repo-path>     # score one repo; print scorecard
trellis drift <repo-path>     # L1 canonical-config drift only
trellis fleet                 # audit every target in targets.yaml
trellis report                # render history/dashboard from SQLite
trellis rubric [--validate]   # print the loaded rubric (and validate its invariants)
trellis standards             # show canonical manifest + versions
```

`--json` / `--md` switch terminal output to machine/report shapes.

### Exit codes (SPEC §12)

Every command exits `0` clean, `2` when a `--fail-on` policy trips (the report
is still emitted to stdout; the reason goes to stderr), or `1` on an operational
error (the command could not run). The default policy (flag omitted) fails on a
**gate** criterion failing **or** canonical **drift**; `--fail-on
gate|drift|level|none` narrows it to one dimension (or disables it), and
`--fail-on level` compares the audited level against `--min-level` (default
`3`). `EXIT` lives in `src/cli/output.ts`; the assessment is core
(`assessReport` in `src/report/assess.ts`, `assessFleet` in
`src/fleet/assess.ts`), so the CLI and SDK gate identically.

### Programmatic SDK (`src/client/`)

`src/client/index.ts` exposes `audit` / `drift` / `fleet` / `report` / `rubric`
plus the `assessReport` / `assessFleet` exit-code rule. Each is a direct call to
the same core service the CLI folds (`runAudit`, `driftRepo`, `runFleetTargets`,
`buildReport`, `summarizeRubric`) — **no logic beyond type shaping**. Request
types mirror the core option types (`// Mirrors src/<x>`); responses are the core
report shapes. The deep-equal test in `src/client/index.test.ts` proves a CLI
audit and an SDK audit are one code path.

### Quality gates

`bun run check:all` (alias `bun run verify`) is the canonical quiet runner
`scripts/check-all.ts` — byte-identical across the os-eco fleet (see the
os-eco meta-repo's `docs/check-all-standard.md`, the same standard trellis's
own rubric audits for). Never edit it in place; per-repo variation lives in
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
- Golden fixtures live under `__golden__/` (e.g. captured Pi RPC sessions,
  SPEC §9.7). Regenerate only via the documented update gate, never by hand.
  Investigation goldens (`src/investigation/__golden__/<area>.jsonl`) are
  re-recorded with `TRELLIS_UPDATE_PI_GOLDEN=1 bun run
  scripts/update-pi-golden.ts --live` — both gates are required, so CI (which
  sets neither) never makes a model call. Until a live capture exists the frozen
  fixtures are hand-authored to the v0.74.0 wire shape (see
  `src/investigation/__golden__/README.md`); the offline harness
  (`src/investigation/golden.test.ts`) replays parser → zod → grader with no
  network either way.
- YAML config keys (rubric data, `targets.yaml`) stay in the schema's casing.

Enforced by Biome's `style.useFilenamingConvention` rule in `biome.json`.

### Identifiers

- `camelCase` for functions, variables, instance fields.
- `PascalCase` for types, interfaces, classes.
- `SCREAMING_SNAKE_CASE` for module-level true constants (`RUBRIC_VERSION`,
  `VERSION`).
- Booleans read as predicates: `isSkippable`, `hasDetector`.

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible
  `undefined` from indexing.
- No `any`; use `unknown` and narrow (zod at every external boundary).
- Import with `.ts` extensions.
- Tab indentation, 100-char line width (Biome enforces).

### Architecture discipline (api>cli>sdk, SPEC §13.1)

- All behavior lives in the **core** modules under `src/` (`src/rubric/`,
  `src/discovery/`, `src/detectors/`, `src/investigation/`, `src/scoring/`,
  `src/standards/`, `src/fleet/`, `src/store/`, `src/report/`). No business
  logic anywhere else.
- `src/cli/` is a **thin** commander pass-through; `src/client/` is a typed
  SDK whose types **mirror the core** (annotate `// Mirrors src/<x>`). Both
  call the same core functions so a programmatic audit and a CLI audit
  exercise one code path.
- The rubric (WHAT) never names a tool; detectors (HOW) are tool-specific and
  live in per-language adapters. Keep that seam clean.

### Test naming

- `describe("<unitUnderTest>")` + `test("verb-led behaviour description")`.
- No `should`, no `it`.
- No mocks for filesystem or SQLite — use temp dirs and `:memory:`/temp DBs.
  Stub only at true external boundaries (the Pi RPC process); the layers above
  run real code paths against golden fixtures.

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
`secret`, `authorization`, `set-cookie`) — relevant for the Pi provider's env
passthrough (SPEC §9.4). Add new redact paths in the same commit that
introduces a new sensitive field.

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
   `scoring: clamp coverage at category boundary`).
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
under test as `<name>.test.ts`. Offline golden-fixture suites (Pi RPC, SPEC
§9.7) read from `__golden__/` and must pass with no network.

### CI parity

`.github/workflows/ci.yml` runs `bun run check:all` and uploads
`coverage/lcov.info` and `junit.xml`. Local `check:all` failures will break CI;
do not push hoping CI will pass. The `check:ci-parity` gate enforces this
mechanically: every `bun run <x>` in `ci*.yml` must be reachable from the
`check:all` manifest, or carry a justified entry in
`scripts/ci-parity-config.json` (`test:ci` aliases to `check:coverage`; the
`report:*` summaries are CI-only).

### Dogfood

trellis audits itself: `trellis audit .` should band L4+ (SPEC §13, seeds
`trellis-a534`). Treat a regression in trellis's own score as a real failure.

## Further reading

- [`SPEC.md`](SPEC.md) — the V1 design record (authoritative)
- [`README.md`](README.md) — user-facing pitch + install
- [`CLAUDE.md`](CLAUDE.md) — tool-specific conventions for agents
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`RUNBOOK.md`](RUNBOOK.md) — release / triage / rollback procedure
- [`docs/architecture.mmd`](docs/architecture.mmd) — module graph
- `scripts/` — ratchet scripts and pre-commit hook (lands with `trellis-4ec4`)
- `.github/workflows/` — CI + sync-labels + publish (lands with `trellis-7baf`)
