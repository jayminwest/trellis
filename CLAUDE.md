# trellis

Deterministic, offline-by-default sloppiness audit for TypeScript/TSX
workspaces. trellis parses source with the TypeScript compiler API and
measures structural debt — complexity, structural erosion, duplication, and
import cycles — plus a separate, non-scoring inspection of safeguard
configuration (hooks and check wiring). Each run emits a versioned report
with a **0–100 sloppiness index where lower is better** (not a percentage of
bad code; infrastructure cannot offset it), raw metrics, traceable
contributions, ranked hotspots, and safeguard evidence.

**Invariants (SPEC §1):** no-model execution on every audit path; the first
audit needs neither Git nor credentials, a database, network, or installed
project dependencies; one deterministic core serves local, fleet, and CI use
with CLI/SDK parity.

> **Deterministic pivot delivered (plan `pl-b2ea`, SPEC §14).** The public
> readiness catalog and assessment APIs are retired. Legacy internals remain
> for historical compatibility and fixtures; current audit surfaces never
> call them. Legacy readiness history stays separate from sloppiness.

[`SPEC.md`](SPEC.md) is the authoritative design record. [`AGENTS.md`](AGENTS.md)
is the canonical agent guide; this file adds tool-specific conventions and the
os-eco session bootstrap.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Validation:** zod (report/configuration contracts, §6).
- **Lint/format:** Biome, `--error-on-warnings`, tab indent / 100-col.
- **Storage:** `bun:sqlite` (opt-in run history only; audits are stateless by
  default).
- **CLI:** commander; progress and handled errors write to stderr.
- **Parsing:** the pinned TypeScript compiler API — one shared parse layer
  reused by all **native** metrics within an audit. No LLM provider exists
  in the product (no-model invariant, SPEC §1); optional analysis providers
  (contracted, SPEC §16) are deterministic local tools — never models.

## Architecture (api>cli>sdk core discipline, SPEC §13.1)

All behavior lives in one surface-agnostic **domain core**; every other surface
is a thin pass-through, so the surfaces cannot drift out of sync. The tree
below is the current layout; `rubric/` and `detectors/` are internal legacy
compatibility modules, excluded from the public deterministic audit path.

```
src/
  cli/            # THIN commander entrypoints; parse args, call core, shape output
  client/         # typed SDK; request/response types MIRROR the core (// Mirrors src/<x>)
  audit/          # deterministic core: auditWorkspace + runWorkspaceAudit service
  config/         # declarative audit configuration (trellis.yaml, SPEC §6.5)
  contract/       # versioned zod contracts: metrics, findings, report, config (§6)
  discovery/      # TS/TSX source discovery → classified source-set inventory (§3.1)
  syntax/         # shared parse layer (pinned TS compiler API) + function inventory
  metrics/        # complexity, erosion, duplication, import graph/cycles (§5)
  safeguards/     # hook/check configuration inspection (non-scoring, §5.5)
  scoring/        # pure provisional sloppiness formula (§7)
  report/         # terminal / JSON / markdown renderers
  compare/        # artifact comparison + declarative failure policies (§9)
  store/          # schema.sql + migrations/ (opt-in history; legacy runs kept
                  #   separate, SPEC §10)
  history/        # sloppiness dashboard projection over the store
  fleet/          # targets.yaml loader + multi-repo orchestration (optional, §11)
  standards/      # canonical/ (bundled files), manifest.yaml, drift.ts
                  #   (separate capability; never feeds the sloppiness index)
  rubric/         # internal legacy rubric data + historical types/fixtures
  detectors/      # internal legacy adapters; not called by public audits
  legacy.ts       # retired investigation-config rejection (actionable errors)
  index.ts        # public lib entry — VERSION constant only (lockstep w/ package.json)
```

- **Core** = every module above except `cli/` and `client/`. It holds *all*
  validation, measurement, scoring, and drift logic. There is **no HTTP
  server** (a network API is a deferred surface over this same core).
- **CLI** never reimplements logic; **SDK** calls the same core functions
  in-process, so a programmatic audit and a CLI audit exercise one code path.
- **Sync enforcement:** single core + strict `tsc` over mirrored SDK types +
  golden snapshots of stable output shapes, all wired into one `check:all` CI
  runs verbatim. Drift becomes a red build, not a review judgment call.

**Provider evidence (planned, SPEC §16, plan `pl-43c5`):** optional
supplemental providers — pinned jscpd, dependency-cruiser, Knip; SonarJS
gated on a documented distribution decision — run only on explicit opt-in,
stay unscored, and never relax the no-model, offline, no-target-command
invariants. Native analysis and the calibrated scoring remain
authoritative; provider failures are located `unavailable`/`incomplete`
evidence (policy exit `2` only via a violated declarative requirement;
invalid configuration stays exit `1`). Implementation lands with steps
`trellis-90d6` onward; research record:
[`docs/research/provider-spike.md`](docs/research/provider-spike.md).

See [`docs/architecture.mmd`](docs/architecture.mmd) for the rendered graph.

## Conventions

- **Filenames:** `kebab-case.ts`. Tests are `<name>.test.ts` beside the unit.
  Golden fixtures under `__golden__/`.
- **Identifiers:** `camelCase` values, `PascalCase` types, `SCREAMING_SNAKE_CASE`
  constants (`VERSION`).
- **Imports:** `.ts` extensions; zod at every external boundary.
- **Tests:** `describe("<unit>")` + `test("verb-led …")`, no `should`/`it`. No
  mocks for fs/SQLite — temp dirs and `:memory:`/temp DBs. Stub only true
  external process boundaries; layers above run real code against goldens.
- **Debt markers:** every `TODO`/`FIXME`/`HACK`/`XXX` carries a tracker on the
  same line — `trellis-XXXX` / `mx-XXXX` / `#NNN` / a URL.
- **Dogfood:** trellis audits
  itself offline; a regression in its own sloppiness index is a real failure.
  The quality-gate ratchets stay binding throughout the transition.

## Build & Test Commands

```bash
bun install                   # install dependencies
bun test                      # run all tests
bun test src/scoring/index.test.ts   # single file
bun run lint                  # biome check --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run check:all             # canonical quiet runner: 9 core gates in fleet order
bun run verify                # alias for check:all
bun run check:coverage        # tests + coverage ratchet
```

`check:all` is `scripts/check-all.ts`, byte-identical to the fleet template
(os-eco meta-repo `docs/check-all-standard.md`) — never edit it in place. It
runs lint, typecheck, check:agents, check:dups, check:deps, check:size,
check:debt, check:coverage, then check:ci-parity (CI ⇄ local parity; escape
hatches in `scripts/ci-parity-config.json`). Run `bun run check:all` before
every commit.

## Session Bootstrap (os-eco tooling)

At the **start of every session**, run all three:

```bash
sd prime     # Seeds: rules, command reference, workflows
ml prime     # Mulch: project conventions, patterns, decisions, failures
cn prime     # Canopy: prompt workflow context (if .canopy/ present)
```

**Quick reference:**

- **Seeds** — `sd ready` (unblocked work), `sd update <id> --status in_progress`,
  `sd close <id>`, `sd sync` before pushing.
- **Mulch** — `ml search "query"` before implementing; `ml record <domain>
  --type <convention|pattern|failure|decision|reference|guide> ...` for
  insights; `ml sync` to validate + commit `.mulch/`.
- **Canopy** — `cn list`, `cn render <name>`, `cn emit --all`. Do not hand-edit
  emitted files; `cn update` then `cn emit`.

### Before you finish

1. Close completed issues: `sd close <id>`; file remaining work: `sd create`.
2. Record insights worth preserving: `ml record <domain> --type <type> ...`.
3. Validate + sync: `sd sync && ml sync`.
4. Run `bun run check:all`; verify `git status` is clean.
5. Push only when the user asks.

## Releases

Use the `/release` slash command (`.claude/commands/release.md`): patch-default
bump, sync `package.json` "version" and `src/index.ts` `VERSION`, roll
`CHANGELOG.md` `[Unreleased]` into a dated section, update this file and
`README.md` if the surface changed, commit. The version-gated publish workflow
(seeds `trellis-3447`/`trellis-7baf`) fails if the two version sources disagree.
See [`RUNBOOK.md`](RUNBOOK.md) for the full release / triage / rollback
procedure.
