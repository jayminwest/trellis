# trellis

Agentic-readiness audit & sync for code repositories. A repo is scored 0–100%
across a versioned, 9-category / 90-criterion rubric, mapped to a maturity
Level 1–5, with score history tracked centrally so drift surfaces over time.
~78% of criteria are deterministic file/config/command checks; the rest are
graded deterministically from facts gathered by a bounded LLM investigation
pass. trellis also detects **canonical-config drift** against a bundled,
versioned `standards/` set with per-repo allowed deltas.

**The rubric (WHAT) never names a tool.** Detectors (HOW) are tool-specific and
live in per-language adapters. That seam is the whole design — keep it clean.

[`SPEC.md`](SPEC.md) is the authoritative V1 design record. [`AGENTS.md`](AGENTS.md)
is the canonical agent guide; this file adds tool-specific conventions and the
os-eco session bootstrap.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Validation:** zod (rubric schema, findings schemas).
- **Lint/format:** Biome, `--error-on-warnings`, tab indent / 100-col.
- **Storage:** `bun:sqlite` (run history + drift queries).
- **CLI:** commander; **logging:** pino.
- **LLM provider:** Pi in RPC mode (`pi --mode rpc`), exercised against frozen
  golden fixtures offline (SPEC §9).

## Architecture (api>cli>sdk core discipline, SPEC §13.1)

All behavior lives in one surface-agnostic **domain core**; every other surface
is a thin pass-through, so the surfaces cannot drift out of sync.

```
src/
  cli/            # THIN commander entrypoints; parse args, call core, shape output
  client/         # typed SDK; request/response types MIRROR the core (// Mirrors src/<x>)
  rubric/         # WHAT: schema.ts (zod), categories.yaml, repo-scope.yaml,
                  #       app-scope.yaml, version.ts (RUBRIC_VERSION + comparability)
  discovery/      # app discovery: independently-deployable dirs → apps
  detectors/      # HOW (deterministic): registry.ts (criterion id → detector),
                  #   common/, lang/{typescript,swift,python}/, oseco/
  investigation/  # HOW (agent): areas.ts (4 fixed areas), findings.ts (zod),
                  #   grader.ts (DETERMINISTIC facts → pass/fail/N-A), provider/pi/
  scoring/        # pass-rate, coverage clamp, naKind handling, bands → level
  standards/      # canonical/ (bundled files), manifest.yaml, drift.ts
  fleet/          # targets.yaml loader + multi-repo orchestration
  store/          # schema.sql + migrations/ (runs / criterion_results / investigation_cache)
  report/         # terminal / JSON / markdown renderers
  index.ts        # public lib entry — VERSION constant only (lockstep w/ package.json)
```

- **Core** = every module above except `cli/` and `client/`. It holds *all*
  validation, scoring, drift, and investigation logic. There is **no HTTP
  server** in MVP (a network API is a deferred surface over this same core).
- **CLI** never reimplements logic; **SDK** calls the same core functions
  in-process, so a programmatic audit and a CLI audit exercise one code path.
- **Sync enforcement:** single core + strict `tsc` over mirrored SDK types +
  golden snapshots of stable output shapes, all wired into one `check:all` CI
  runs verbatim. Drift becomes a red build, not a review judgment call.

See [`docs/architecture.mmd`](docs/architecture.mmd) for the rendered graph.

## Conventions

- **Filenames:** `kebab-case.ts`. Tests are `<name>.test.ts` beside the unit.
  Golden fixtures under `__golden__/`.
- **Identifiers:** `camelCase` values, `PascalCase` types, `SCREAMING_SNAKE_CASE`
  constants (`RUBRIC_VERSION`, `VERSION`).
- **Imports:** `.ts` extensions; zod at every external boundary.
- **Tests:** `describe("<unit>")` + `test("verb-led …")`, no `should`/`it`. No
  mocks for fs/SQLite — temp dirs and `:memory:`/temp DBs. Stub only the Pi RPC
  process boundary; layers above run real code against goldens.
- **Debt markers:** every `TODO`/`FIXME`/`HACK`/`XXX` carries a tracker on the
  same line — `trellis-XXXX` / `mx-XXXX` / `#NNN` / a URL.
- **Dogfood:** trellis must score L4+ against itself; adopt the same ratchets it
  audits for.

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
