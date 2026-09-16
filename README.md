# trellis

Agentic-readiness audit & sync for code repositories — score a repo against a
de-branded rubric, detect canonical-config drift, and keep a fleet in standard.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> An AI-ready codebase is one where (a) any change is verifiable in under 60
> seconds, (b) the repo answers its own onboarding questions, (c) every standard
> is enforced by a machine, (d) every action is reversible, and (e) the team
> treats agents as users they're designing for.

"Agents are not a hiring problem. They're an environment problem." **trellis
measures the environment.**

## What trellis is

trellis is a **deterministic, offline** audit tool that keeps a
fleet of repositories in sync on *agent-readiness*: how legible and verifiable a
repo is to a non-human collaborator. It does two complementary things:

1. **Readiness audit (the rubric).** Scores a repo's intrinsic agent-readiness
   against a versioned, 8-category / 70-criterion rubric and maps the 0–100%
   score to a maturity Level 1–5. Every criterion is a deterministic
   file/config/command check — no audit path spawns an agent or calls a model.
2. **Canonical config drift (L1).** Compares a repo's shared tooling files
   (Biome config, `tsconfig` base, CI workflow, `AGENTS.md` template,
   pre-commit hook, `.seeds/` skeleton, …) against trellis's bundled, versioned
   canonical `standards/` set — honoring per-repo allowed deltas.

The **rubric (WHAT) never names a tool.** **Detectors (HOW)** are tool-specific
and live in per-language adapters. That seam lets one rubric retarget
TypeScript, Swift, Python, and arbitrary external repos. trellis is
stack-agnostic by design but stack-first in practice: it mirrors the warren /
burrow Bun + TypeScript-strict + Biome + SQLite stack.

> **Status:** `0.1.0` — the [`SPEC.md`](SPEC.md) MVP is complete: all SPEC §14
> milestones have landed, and the CLI surface and module layout below are
> implemented as shown.

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

`commander`-based; human-readable terminal output by default, `--json` / `--md`
for machine/report output. Six subcommands (SPEC §12):

```bash
trellis audit <repo-path>            # score one repo; print scorecard
  [--json|--md] [--rubric-version <v>] [--canonical <v>]
  [--fail-on gate|drift|level|none] [--min-level <n>]
trellis drift <repo-path>            # L1 canonical-config drift only
  [--canonical <v>] [--fail-on drift|none]
trellis fleet                        # audit every target in targets.yaml
  [--targets targets.yaml] [--json|--md] [--fail-on gate|drift|level|none] [--min-level <n>]
trellis report [--repo <id>]         # render history/dashboard from SQLite
  [--since <date>] [--json|--md]
trellis rubric [--validate]          # print the loaded rubric (+ validate invariants)
trellis standards                    # show canonical manifest + versions
```

### Exit codes (CI gate, SPEC §12)

trellis drops into a CI step per repo. Every command exits:

- **`0`** — clean.
- **`2`** — a `--fail-on` policy tripped. The report is still printed to stdout
  (the reason goes to stderr), so you keep the scorecard *and* the red build.
- **`1`** — an operational error (bad flags, unreadable rubric, missing repo) —
  trellis could not run. Distinct from `2` so CI can tell "trellis broke" from
  "the repo failed the bar."

`--fail-on` tunes which dimension gates the build:

| value          | exits non-zero when…                                              |
| -------------- | ---------------------------------------------------------------- |
| *(default)*    | a **gate** criterion fails **or** canonical **drift** is detected |
| `gate`         | a gate criterion (a category's floor) is measured and not passing |
| `drift`        | any canonical file is in a `drift`/`missing` state                |
| `level`        | the audited level is below `--min-level` (default `3`)            |
| `none`         | never — always exit `0` (report only)                            |

`trellis drift` only knows the `drift` dimension (default: fail on drift;
`--fail-on none` disables). `trellis fleet` applies the policy per target, and
any target that cannot be audited trips the gate unless `--fail-on none`.

### Programmatic SDK (`@os-eco/trellis-cli`)

The same domain core is exposed as a typed, in-process SDK — a CLI audit and an
SDK audit run **one code path**, so their reports are deep-equal. Request types
mirror the core option types; responses are the core report shapes.

```ts
import { audit, drift, fleet, report, rubric, assessReport, loadRubric } from "@os-eco/trellis-cli/client";

const result = await audit("/path/to/repo", { persist: false });   // → Report (SPEC §6.3)
const verdict = assessReport(result, loadRubric());                // → { failed, reasons } (the --fail-on rule)
if (verdict.failed) process.exit(2);

const d = drift("/path/to/repo", { canonicalVersion: "1.0.0" });   // → DriftReport (SPEC §10)
const f = await fleet("targets.yaml");                             // → FleetReport (SPEC §6.5)
const history = report({ repo: "warren" });                        // → HistoryReport (SPEC §11)
const r = rubric();                                                // → RubricSummary (SPEC §6.1)
```

### Fleet declaration (`targets.yaml`)

Because trellis keeps audit state centrally, per-repo *allowed deltas* for
canonical-config drift live in the fleet file — not inside the audited repos.
Copy [`targets.yaml.example`](targets.yaml.example) to `targets.yaml`
(gitignored) and edit:

```yaml
defaults:
  canonicalVersion: "1.0.0"          # which standards/ version to compare against

targets:
  - id: warren
    path: /path/to/os-eco/warren
    languages: [typescript]          # optional hint; auto-detected if omitted
    canonical:
      version: "1.0.0"               # per-repo override of defaults.canonicalVersion
      allowedDeltas:                 # files/keys this repo may diverge on
        - file: biome.json
          reason: "wider line width for generated migrations"
    skip: [dast_scanning]            # optional: force-N/A specific criteria

  - id: my-swift-app
    path: /path/to/my-swift-app
    languages: [swift]

  - id: external-repo
    path: ../some-non-oseco-repo
    languages: [python]              # hint a non-TypeScript fleet member
```

## Architecture

```
src/
├─ cli/            # THIN commander entrypoints; delegate to core (§13.1)
├─ client/         # typed SDK over the domain core; mirrors core types
├─ rubric/         # the WHAT: loads + validates rubric data (categories + 90 criteria)
├─ discovery/      # app discovery (independently-deployable dirs → apps)
├─ detectors/      # the HOW (deterministic): common + lang/{ts,swift,python}
├─ scoring/        # pass-rate, coverage clamp, repo/app aggregation, bands → level
├─ standards/      # canonical config drift (L1): canonical/ + manifest.yaml + drift.ts
├─ fleet/          # targets.yaml loader + multi-repo orchestration
├─ store/          # bun:sqlite history (runs / criterion_results)
└─ report/         # terminal / JSON / markdown renderers
```

trellis follows the same **api>cli>sdk** discipline as warren: all behavior
lives in one surface-agnostic domain core, and every other surface (CLI, SDK)
is a thin pass-through. See [`docs/architecture.mmd`](docs/architecture.mmd)
for the module graph and [`SPEC.md`](SPEC.md) §13.1 for the rationale.

## The os-eco ecosystem

trellis is the **measurement surface** of
[os-eco](https://github.com/jayminwest/os-eco), the AI agent tooling ecosystem.
It grades the very properties the rest of the toolchain provides — and is
designed to be driven by them:

- **warren** orchestrates the fix: a trellis drift report is a ready-made
  Warren plan (one PR per drifted repo) once the read-only signal is trusted
  (SPEC §15).
- **seeds / mulch / canopy / plot** are detected natively (SPEC §8.4) — their
  presence is evidence of agent-readiness.

Each tool works standalone; trellis is the one that tells you whether the rest
of the environment is doing its job.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) (the
canonical guide for AI agents). Run `bun run check:all` before every PR.
Security reports go through [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © Jaymin West
