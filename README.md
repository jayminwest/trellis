# trellis

Deterministic, offline-by-default **sloppiness audit** for TypeScript/TSX
workspaces — a 0–100 index of structural debt where **lower is better**, with
the raw metrics, traceable score contributions, and ranked hotspots behind it.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

trellis parses your source once with the TypeScript compiler API and measures
**complexity**, **structural erosion**, **duplication**, and **import cycles**,
plus a separate, non-scoring inspection of safeguard configuration (hooks and
check wiring). It answers one question: *how sloppy is this TypeScript tree,
where exactly, and is it getting worse?*

Three invariants define the tool (SPEC §1):

1. **No-model execution.** No audit path spawns an agent, calls a model, or
   consumes model-derived grading. There is no provider configuration anywhere
   in the shipped surface.
2. **Offline and zero-footprint by default.** The first audit needs neither
   Git nor credentials, a database, network, or installed project
   dependencies. It reads files as they exist on disk and writes nothing
   unless you ask (`--out`, `--history`).
3. **One core, every surface.** The CLI, the SDK, fleet runs, and CI all
   exercise the same deterministic core — parity is proven by deep-equal
   tests, not asserted.

> **Status:** `0.2.0` — the deterministic core of [`SPEC.md`](SPEC.md) is
> implemented: discovery → parse → measure → score → report, baseline
> comparison and declarative policies, opt-in history, and fleet/standards as
> optional consumers. The scoring formula is **provisional**
> (`0.1.0-provisional`) pending further calibration.

## Install

trellis runs on [Bun](https://bun.sh) (≥ 1.1), no build step.

```bash
# from npm (once published)
bun install -g @os-eco/trellis-cli
trellis --help

# from source
git clone https://github.com/jayminwest/trellis && cd trellis
bun install
bun run src/cli/main.ts --help     # or: bun link, then `trellis --help`
```

## Usage

`commander`-based; human-readable terminal output by default, `--json` /
`--md` for machine/report output.

```bash
trellis audit <path>               # measure + score one workspace; print the sloppiness report
  [--json|--md] [--out <file>]     #   artifact: .json/.md inferred from the extension
  [--baseline <report.json>]       #   compare against a saved report (§9)
  [--config <file>]                #   explicit trellis.yaml (default: discovered at the root)
  [--history] [--db <path>]        #   opt-in persistence (default: stateless)
  [--quiet|--verbose]
trellis compare <a.json> <b.json>  # compare two saved report artifacts (no audit)
  [--config <file>]                #   trellis.yaml whose policy block gates the comparison
trellis fleet                      # audit every target in targets.yaml through the same core
  [--targets targets.yaml] [--history]
trellis report                     # sloppiness history/dashboard from SQLite
  [--repo <id>] [--since <date>]   #   (legacy readiness runs kept visibly separate)
trellis standards                  # canonical-config drift manifest (separate capability)
```

The default `audit` run is **stateless** — no database, no report files —
unless `--history` / `--out` ask. History lives centrally at
`~/.trellis/trellis.db` (`$TRELLIS_DB` or `--db` overrides), never inside the
audited repo.

### Exit codes (SPEC §9)

- **`0`** — clean.
- **`2`** — a **policy** tripped (max index, a metric budget, score
  regression vs. the baseline, or a `failOnNew` finding kind). The report is
  still printed to stdout; the reasons go to stderr, so you keep the
  scorecard *and* the red build.
- **`1`** — an **operational** error (bad flags, unreadable config,
  incompatible comparison) — trellis could not run. Distinct from `2`, so CI
  can tell "the repo failed the bar" from "trellis broke".

Policy is **declarative**: it lives in the audited workspace's `trellis.yaml`
and gates `audit` and `compare` identically from CLI and SDK. Policy never
mutates scoring weights.

```yaml
# trellis.yaml (optional; sensible defaults without it)
source:
  exclude: ["src/generated/**"]        # additions to the documented defaults
  classify:
    "scripts/tools/**": "test"          # explicit source-set overrides
policy:                                 # failure policy only — never scoring input
  maxIndex: 40
  regression:                           # vs. the --baseline report
    maxIncrease: 2                      # absolute tolerance, index points
    maxIncreasePercent: 10              # relative tolerance, % of baseline index
  budgets:
    duplication.density.production: { max: 0.05 }
  failOnNew: [import-cycle, complexity.hotspot]
```

## Examples

Every example below runs fully offline against the same CLI — no hosted
service, no credentials, no Git requirement.

### Local refactor review

Save a report before the refactor, audit again after, and compare the two
artifacts (or just pass `--baseline`):

```bash
trellis audit . --json --out /tmp/before.json --quiet
# ... refactor ...
trellis audit . --json --baseline /tmp/before.json
# or, from saved artifacts only — no audit:
trellis compare /tmp/before.json /tmp/after.json
```

The comparison reports the index move, per-metric deltas, and findings
classified as new / resolved / persistent. With a `policy` block in
`trellis.yaml`, a regression beyond tolerance exits `2` with the reasons on
stderr.

### Optional fleet and history

Audits are stateless by default. Opt in to a central history and to
multi-repo runs:

```bash
trellis audit . --history                 # append this run to ~/.trellis/trellis.db
trellis report                            # dashboard: latest index + compatible-run deltas
trellis report --repo trellis --since 2026-01-01

cp targets.yaml.example targets.yaml      # declare the fleet, then:
trellis fleet --history                   # every target through the same core
```

Fleet entries preserve each target's full report and its own declarative
policy verdict; canonical-config drift rides along as separate, non-scoring
evidence. Legacy readiness runs already in the database stay visible in a
distinct section and are never compared with sloppiness indices.

### CI — pre-release gate (policy failure ≠ operational error)

Pin the analyzer version (report comparability is versioned, SPEC §3.5),
retain the report artifact, and branch on the exit code so a policy failure
and an operational failure page differently:

```yaml
# .github/workflows/sloppiness.yml
name: sloppiness
on:
  pull_request:
  schedule: [cron: "0 6 * * 1"]      # weekly trend run on the default branch

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install -g @os-eco/trellis-cli@0.2.0   # pin the analyzer version

      - name: Audit (never fails this step)
        id: audit
        run: |
          set +e
          trellis audit . --json --out trellis-report.json --quiet
          code=$?
          echo "exit=$code" >> "$GITHUB_OUTPUT"
          exit 0                       # classification happens below

      - uses: actions/upload-artifact@v4   # retain the artifact for compare/triage
        with:
          name: trellis-report
          path: trellis-report.json

      - name: Operational failure (trellis could not run)
        if: steps.audit.outputs.exit == '1'
        run: |
          echo "::error::trellis failed operationally — inspect the audit step log"
          exit 1

      - name: Policy failure (the repo tripped the declared bar)
        if: steps.audit.outputs.exit == '2'
        run: |
          echo "::error::sloppiness policy tripped — see trellis-report.json and stderr above"
          exit 1
```

For a regression gate, download the previous release's artifact and add
`--baseline trellis-report-baseline.json` to the audit (or run
`trellis compare baseline.json current.json --config trellis.yaml` as a
separate step — same policy, no re-audit).

### Programmatic SDK (`@os-eco/trellis-cli/client`)

The same core is exposed as a typed, in-process SDK — a CLI audit and an SDK
audit run **one code path**, so their reports are deep-equal.

```ts
import { audit, compare, fleet, report } from "@os-eco/trellis-cli/client";

const result = await audit("/path/to/workspace");        // → WorkspaceAuditResult
if (result.policy.failed) process.exit(2);               // the declarative §9 verdict
const reportJson = result.report;                        // → AuditReport (SPEC §6.4)

const diff = await compare("/tmp/before.json", "/tmp/after.json");
const fleetReport = await fleet("targets.yaml");
const history = report({ repo: "trellis" });
```

## What the index measures

The headline number is a **weighted composite, not a percentage of bad
code** — 40 does not mean "40% of the code is bad." Every renderer shows the
direction and scoring version alongside it. Infrastructure cannot offset it:
safeguards, CI wiring, hooks, and test volume contribute nothing, and test
code is measured separately from production code.

### Metric catalog (SPEC §5)

| dimension | metrics |
| --- | --- |
| **Complexity** | per-function cyclomatic complexity (`complexity.cc.{p50,p90,max}.{production,test}`), max nesting depth, function counts, SLOC — with ranked `complexity.hotspot` findings |
| **Structural erosion** | function mass = `CC × √SLOC` (`erosion.mass.*`), share of mass in functions with CC > 10 (`erosion.eroded-share.*`) and their count (`erosion.eroded-count.*`) |
| **Duplication** | normalized-token clone groups (type-1 and identifier/literal-renamed type-2, ≥ 100 tokens and ≥ 3 lines), unique affected lines (`duplication.duplicated-lines.*`), density (`duplication.density.*`), group counts (`duplication.groups.*`) — under a declared token/match-work budget that fails `incomplete`, never silently clean |
| **Import cycles** | complete cyclic module groups over a workspace-aware resolved graph (`import-cycle.{groups,modules,density}`), runtime and type-only edges scored separately; unresolved-import coverage rides along (`graph.edges.*`) |
| **Safeguards** (non-scoring) | configuration evidence for Git hooks, agent hooks, lint/typecheck/test scripts, and quality budgets at four evidence levels: `absent` / `configured` / `structurally-wired` / `unknown`. Passing execution is never inferred. |

Only `production` and `test` source sets are scored, separately;
`generated`, `vendored`, and excluded scopes are reported as coverage, not
counted as clean. The index scores the **production** set only.

### The provisional formula (SPEC §7)

Scoring is a pure function of raw metrics — no configuration input, so policy
budgets can never move weights. Each dimension blends a density term with an
absolute-count term (50/50), so large clean additions cannot dilute debt:

| dimension | weight | saturates at |
| --- | --- | --- |
| complexity-erosion | 0.50 | eroded share 0.25 · eroded count 20 |
| duplication | 0.30 | density 0.15 · 15 groups |
| import-cycle | 0.20 | density 0.10 · 5 groups |

Every reported point traces to the raw metric ids and thresholds that
produced it. A required dimension that could not be fully analyzed scores at
full weight and flags the headline `partial` — an apparently complete score
is never published from partial analysis.

## Known limitations

- **TypeScript/TSX only.** Other languages are never analyzed; they surface
  as explicit `unsupported` coverage (a repo that is 60% Python shows 60%
  unsupported — not a clean bill).
- **Type-3 near clones are out of scope.** A divergence splits a clone into
  its maximal exact-normalized runs, each reported independently if above
  the 100-token minimum.
- **Configuration inspection, not execution.** trellis never runs the
  target's tests, builds, linters, or hooks and never claims they pass; a
  `structurally-wired` safeguard means "verifiably connected to an
  enforcement point," nothing more. Unsupported shell constructs stay
  `unknown`, never guessed.
- **Resolution is local-only.** Absent `node_modules` degrades import
  resolution to documented `unresolved` edges — never a network fetch — and
  incomplete graph coverage rolls cycle metrics up `incomplete`.
- **Explicitly not in this product:** unused-code analysis, architecture
  rules beyond cycle detection, any AI feature, a web UI, hosted/scheduled
  services, automatic remediation, and rewrites in other languages
  (SPEC §2, §15).

## Migrating from the readiness product

The pre-`0.2` **agent-readiness** product (90-criterion rubric, maturity
levels, LLM investigation layer) is **retired**, not reinterpreted
(SPEC §14):

- **Scores don't carry over.** Readiness percentages/levels and the
  sloppiness index are different quantities. Existing history databases keep
  their legacy runs, visibly labeled, and never trend them against the new
  index. There is nothing to convert — start a fresh baseline with
  `trellis audit . --json --out baseline.json`.
- **Retired flags fail fast.** `--rubric-version`, `--min-level`,
  `--fail-on gate|level`, `--no-cache`, provider/model knobs, and the
  investigation env vars exit `1` with an actionable "removed in the
  deterministic pivot" message instead of silently changing meaning. The
  new failure policy is the declarative `policy` block above.
- **`targets.yaml` keys retired.** Per-target `skip` and `languages` and
  `defaults.investigation` are rejected with migration errors; keep
  `id`/`path`/`config`/`canonical`.
- **`drift` / `rubric` / `standards`** remain as transitional subcommands
  (canonical-config drift is the one capability carried forward unchanged);
  they retire in the release stages.

## Architecture

```
src/
├─ cli/            # THIN commander entrypoints; delegate to core (SPEC §13.1)
├─ client/         # typed SDK over the core; mirrors core types
├─ audit/          # deterministic core: discover → parse → measure → score → assemble
├─ config/         # declarative audit configuration (trellis.yaml)
├─ contract/       # versioned zod contracts: metrics, findings, report, config
├─ discovery/      # TS/TSX source discovery → classified workspace inventory
├─ syntax/         # shared parse layer (pinned TS compiler API) + function inventory
├─ metrics/        # complexity, erosion, duplication, import graph/cycles
├─ safeguards/     # hook/check configuration inspection (non-scoring)
├─ scoring/        # provisional sloppiness formula (pure)
├─ report/         # terminal / JSON / markdown renderers
├─ compare/        # artifact comparison + declarative failure policies
├─ store/          # OPTIONAL SQLite history (append-only; legacy runs separate)
├─ history/        # history dashboard projection
├─ fleet/          # OPTIONAL targets.yaml orchestration over the same core
└─ standards/      # canonical-config drift (separate capability)
```

All behavior lives in the core; `src/cli/` and `src/client/` are thin
pass-throughs (**api>cli>sdk**, SPEC §13.1). See
[`docs/architecture.mmd`](docs/architecture.mmd) for the module graph and
[`docs/corpus-validation.md`](docs/corpus-validation.md) for the fixed-corpus
score-behavior and performance record.

## The os-eco ecosystem

trellis is the **measurement surface** of
[os-eco](https://github.com/jayminwest/os-eco), the AI agent tooling
ecosystem: it gives the fleet an objective, reproducible read on structural
code health. Each tool works standalone; trellis is the one that tells you
whether the codebase itself is holding up.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) (the
canonical guide for AI agents). Run `bun run check:all` before every PR.
Security reports go through [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © Jaymin West
