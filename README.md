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

trellis is a **mostly-deterministic, partly-agentic** audit tool that keeps a
fleet of repositories in sync on *agent-readiness*: how legible and verifiable a
repo is to a non-human collaborator. It does two complementary things:

1. **Readiness audit (the rubric).** Scores a repo's intrinsic agent-readiness
   against a versioned, 9-category / 90-criterion rubric and maps the 0–100%
   score to a maturity Level 1–5. ~78% of criteria are deterministic
   file/config/command checks; the rest are decided by a deterministic grader
   consuming objective facts gathered by a bounded LLM investigation pass.
2. **Canonical config drift (L1).** Compares a repo's shared tooling files
   (Biome config, `tsconfig` base, CI workflow, `AGENTS.md` template,
   pre-commit hook, `.seeds/` skeleton, …) against trellis's bundled, versioned
   canonical `standards/` set — honoring per-repo allowed deltas.

The **rubric (WHAT) never names a tool.** **Detectors (HOW)** are tool-specific
and live in per-language adapters. That seam lets one rubric retarget
TypeScript, Swift, Python, and arbitrary external repos. trellis is
stack-agnostic by design but stack-first in practice: it mirrors the warren /
burrow Bun + TypeScript-strict + Biome + SQLite stack.

> **Status:** pre-release (`0.0.1`), tracking the [`SPEC.md`](SPEC.md) MVP. The
> CLI surface and module layout below are the target shape; see the milestones
> in SPEC §14 for what has landed.

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
  [--json|--md] [--no-cache] [--rubric-version <v>] [--canonical <v>]
trellis drift <repo-path>            # L1 canonical-config drift only
trellis fleet                        # audit every target in targets.yaml
  [--targets targets.yaml] [--json|--md]
trellis report [--repo <id>]         # render history/dashboard from SQLite
  [--since <date>] [--json|--md]
trellis rubric [--validate]          # print the loaded rubric (+ validate invariants)
trellis standards                    # show canonical manifest + versions
```

Exit codes are CI-tunable: `0` clean, non-zero when a gate criterion fails or
drift is detected (`--fail-on level|gate|drift|none`), so trellis drops into a
CI step per repo.

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
    osecoDetectors: false            # disable os-eco-native detectors (SPEC §8.4)
```

## Architecture

```
src/
├─ cli/            # THIN commander entrypoints; delegate to core (§13.1)
├─ client/         # typed SDK over the domain core; mirrors core types
├─ rubric/         # the WHAT: loads + validates rubric data (categories + 90 criteria)
├─ discovery/      # app discovery (independently-deployable dirs → apps)
├─ detectors/      # the HOW (deterministic): common + lang/{ts,swift,python} + oseco
├─ investigation/  # the HOW (agent): 4 areas → structured facts → deterministic grader
├─ scoring/        # pass-rate, coverage clamp, repo/app aggregation, bands → level
├─ standards/      # canonical config drift (L1): canonical/ + manifest.yaml + drift.ts
├─ fleet/          # targets.yaml loader + multi-repo orchestration
├─ store/          # bun:sqlite history (runs / criterion_results / investigation_cache)
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
