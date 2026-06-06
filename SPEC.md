# trellis — agentic-readiness audit & sync

> Spec draft. Greenfield os-eco project. Codename **trellis** — the structure
> that keeps growth aligned. Created 2026-06-06 in conversation with KOTA;
> expanded from the original brainstorm + the `../notes` material (the
> 82-criterion `readiness-report-prompt.md`, the 8-principle
> `ai-readiness-principles.md`, and a de-branded read of the day-job
> `PRIVATE-rubric` v0.2.0). This document is the design record; it is moving
> toward "ready to implement."

---

## 1. What trellis is

trellis is a **mostly-deterministic, partly-agentic audit tool** that keeps a
fleet of repositories in sync on *agent-readiness*: how legible and verifiable
a repo is to a non-human collaborator. A repo is scored 0–100% across a
versioned rubric of weighted criteria, mapped to a maturity Level 1–5, and the
score history is tracked centrally so drift surfaces over time.

It does two complementary things:

1. **Readiness audit (the rubric)** — scores a repo's *intrinsic*
   agent-readiness against a 9-category, 90-criterion rubric. ~78% of criteria
   are deterministic file/config/command checks; the rest are decided by a
   deterministic grader consuming objective facts gathered by a bounded LLM
   investigation pass.
2. **Canonical config drift (L1)** — compares a repo's shared tooling files
   (Biome config, tsconfig base, CI workflow, `AGENTS.md` template, pre-commit
   hook, `.seeds/` skeleton, …) against trellis's bundled canonical `standards/`
   set, honoring per-repo allowed deltas.

trellis is **stack-agnostic by design** (tool-agnostic rubric + per-language
detector adapters) but **stack-first in practice**: the operator runs a Bun /
TypeScript-strict / Biome / SQLite / React-Vite stack (the "warren stack"),
plus one Swift project and soon one Python project, and points trellis at
non-os-eco repos as well.

### The frame (from the notes)

> An AI-ready codebase is one where (a) any change is verifiable in under 60
> seconds, (b) the repo answers its own onboarding questions, (c) every standard
> is enforced by a machine, (d) every action is reversible, and (e) the team
> treats agents as users they're designing for.
> — `ai-readiness-principles.md`

"Agents are not a hiring problem. They're an environment problem." trellis
measures the environment.

---

## 2. Goals & non-goals

### MVP goals

- Score a single repo against the full v0.2.0 rubric (90 criteria) and emit a
  scorecard (terminal + JSON + markdown).
- Run the deterministic detector layer for **TypeScript, Swift, and Python**
  apps.
- Run the bounded **agent investigation** layer for the fuzzy criteria, with a
  deterministic grader on top (LLM *execution* layer specified in §9: **Pi in
  RPC mode**).
- Score a fleet of repos declared in a central `targets.yaml`; persist every
  run in a central SQLite history; render an aggregate dashboard.
- Detect **canonical-config drift (L1)** against the bundled `standards/` set,
  honoring per-repo allowed deltas.
- Version the rubric (semver by comparability impact) so a level change is
  attributable to code vs rubric.

### Non-goals (deferred)

- **L3 auto-fix via Warren fan-out** — dispatching N parallel Warren runs to
  remediate drift. Designed-for, not built. See §15.
- **A new memory / spec-first / cost / workflow-eval category** — the four
  dimensions both source rubrics omit. Deferred; we instead add **os-eco-native
  detectors** (§8.4) so warren-stack repos score honestly against existing
  criteria.
- **Per-repo committed scorecards** — state is central (SQLite), not committed
  into each audited repo.
- **A web UI** — CLI-only for MVP. A warren-style React dashboard is a later
  surface.
- **README score badges, kota-sense briefings, auto-filing seeds on drift** —
  adjacent ideas, not now.

---

## 3. Core concepts

### 3.1 Criteria, scopes, levels

- A **criterion** is one machine-checkable signal of readiness. Each carries a
  maturity `level` (1–5) — an attribute of the criterion, not a section. A
  category therefore mixes L1–L5 criteria.
- **Scope** is per-criterion data, not per-category:
  - **repo-scope** — scored once for the whole repo; denominator always `1`.
  - **app-scope** — scored once per declared *app*; denominator `N` = number of
    discovered apps (else `N = 1`); numerator = count of apps that pass.
- **Discovery** is tagged per criterion: `discoveryVia: deterministic | agent`.
  Agent criteria name one of four fixed **investigation areas** (§7).

### 3.2 Skippable & `naKind`

- `skippable: true` criteria may be **N/A** when the target surface is genuinely
  absent. N/A is **not one bucket** — it splits:
  - `not-applicable` — the surface is honestly absent (no DB, no declared apps).
    **Excluded** from the coverage base; a narrow repo is not penalized for what
    it correctly lacks.
  - `no-detector` — trellis *should* have measured it but couldn't (missing
    adapter, tool not installed, ambiguous evidence). **Counted** against
    coverage so it drags the score down.
- Non-skippable criteria can never be N/A; if evidence is ambiguous, they
  **FAIL** (determinism mandate: identical repo → identical output).

### 3.3 Gates & weights (reserved)

- Each category has exactly one **gate** criterion (9 total): the lowest
  non-skippable "floor," below which every higher signal in that category is
  untrustworthy. Authored as a `gate: true` field; **reserved, not read by the
  v0 scorer.**
- Every criterion carries `weight` (default `1`); **reserved, not read by the v0
  scorer.** Authoring it now lets weighted pooling land later without a
  comparability-breaking schema migration.

### 3.4 Scoring

**v0 scorer (equal-weighted):**

```
perCriterionScore_i = numerator_i / denominator_i        # null (N/A) excluded
passRate            = mean(perCriterionScore_i over counted criteria)
passRateLevel       = band(passRate)                      # 20-pt bands
```

**Coverage-aware leveling (the clamp):**

```
coverage      = counted / (counted + no-detector + skipped)
coverageLevel = band(coverage)
level         = min(passRateLevel, coverageLevel)         # can only move DOWN
```

A repo whose passing criteria are a thin slice of its measurable ones cannot
band high; a full-coverage repo is unaffected (clamp is a no-op). The clamp is
**monotonic — it only ever lowers a level.**

**Bands** (identical to both source rubrics): L1 0–20%, L2 20–40%, L3 40–60%,
L4 60–80%, L5 80–100%.

### 3.5 Rubric versioning (drift attribution)

The rubric is a **versioned artifact** (`rubric@X.Y.Z`), semver'd by
*comparability impact*, not code semantics:

- **major** — can move an existing repo's score for unchanged code (criterion
  removed / re-leveled, gate flipped, threshold or leveling math changed).
  Breaks historical comparability.
- **minor** — purely additive (new criterion/category). Old criteria score
  identically; only app-scope `N` denominators grow.
- **patch** — wording only, no scoring impact.

Pre-1.0, comparability-affecting changes ride in the **minor** slot. Every
scorecard records "Level X **against rubric vN**" so a repo dropping a level is
provably a real regression, never a silently-tightened rubric.

---

## 4. Architecture

```
trellis/
├─ src/
│  ├─ cli/                 # THIN commander entrypoints; delegate to core (§13.1)
│  ├─ client/              # typed SDK over the domain core (§13.1); mirrors core types
│  ├─ rubric/              # the WHAT: loads + validates rubric data, schema
│  │  ├─ schema.ts         # zod schemas for criterion / category records
│  │  ├─ categories.yaml   # 9 categories
│  │  ├─ repo-scope.yaml   # 44 repo-scope criteria
│  │  ├─ app-scope.yaml    # 46 app-scope criteria
│  │  └─ version.ts        # RUBRIC_VERSION + comparability policy notes
│  ├─ discovery/           # app discovery (independently-deployable dirs -> apps)
│  ├─ detectors/           # the HOW (deterministic): per-criterion checks
│  │  ├─ registry.ts       # criterion id -> detector binding
│  │  ├─ common/           # language-agnostic detectors (gitignore, env, CI, ...)
│  │  ├─ lang/
│  │  │  ├─ typescript/    # TS adapter (Biome, tsc, knip, jscpd, bun test, ...)
│  │  │  ├─ swift/         # Swift adapter (SwiftLint, swift build/test, ...)
│  │  │  └─ python/        # Python adapter (ruff, mypy, pytest, coverage, ...)
│  │  └─ oseco/            # os-eco-native detectors (seeds/mulch/canopy/plot/...)
│  ├─ investigation/       # the HOW (agent): 4 areas -> structured facts
│  │  ├─ areas.ts          # the 4 fixed investigation-area definitions
│  │  ├─ findings.ts       # zod schemas for facts each area must return
│  │  ├─ grader.ts         # DETERMINISTIC grader: facts -> pass/fail/N-A
│  │  └─ provider/         # Pi RPC execution layer (§9): spawn `pi --mode rpc`
│  │     └─ pi/            #   findings-extension.ts — registers `submit_findings` tool
│  ├─ scoring/             # pass-rate, coverage clamp, repo/app aggregation
│  ├─ standards/           # canonical config drift (L1)
│  │  ├─ canonical/        # the bundled canonical files (semver'd, see §10)
│  │  ├─ manifest.yaml     # canonical file set + per-file version + hash
│  │  └─ drift.ts          # compare target repo vs canonical w/ allowed deltas
│  ├─ fleet/               # targets.yaml loader + multi-repo orchestration
│  ├─ store/               # bun:sqlite history + drift queries
│  │  ├─ schema.sql
│  │  └─ migrations/
│  └─ report/              # terminal / JSON / markdown renderers
├─ standards/              # (alias note) canonical lives under src/standards/canonical
├─ targets.yaml.example
└─ ...
```

The **rubric (WHAT)** never names a tool. **Detectors (HOW)** are tool-specific
and live in per-language adapters. This is the seam that lets the same rubric
retarget TS, Swift, Python, and arbitrary external repos.

---

## 5. The rubric catalog (90 criteria, 9 categories)

De-branded from the v0.2.0 source. Legend: **R**=repo-scope / **A**=app-scope ·
**L**=level · **S**=skippable · **det**=deterministic / **agent[area]** ·
**⛳**=category gate (reserved).

### 5.1 Documentation — 10, all R, all agent
Areas: `documentation`, `agent-config`.

| id | scope/level | discovery | note |
|---|---|---|---|
| `readme` | R/L1 | agent[documentation] | README at root with setup/usage |
| `agents_md` | R/L2 | agent[agent-config] | non-trivial agent-instructions file |
| `build_cmd_doc` | R/L2 | agent[documentation] | build command written down |
| `automated_doc_generation` | R/L2 | agent[documentation] | tool/workflow that generates docs |
| `runbooks_documented` | R/L2 | agent[documentation] | runbooks reachable |
| `single_command_setup` ⛳ | R/L3 | agent[documentation] | one-shot fresh-clone → running dev env |
| `skills` | R/L3 | agent[agent-config] | ≥1 valid skill (`{skill}/SKILL.md`) |
| `documentation_freshness` | R/L3 | agent[documentation] | key docs modified recently |
| `service_flow_documented` | R/L3 | agent[documentation] | arch/flow diagram or dependency docs |
| `agents_md_validation` | R/L4 | agent[agent-config] | automation keeps agent-instructions honest (presupposes `agents_md`) |

### 5.2 Code Quality — 12 (2 R + 10 A), all det

| id | scope/level | flags | note |
|---|---|---|---|
| `large_file_detection` | R/L3 | det | file-size budget enforced |
| `tech_debt_tracking` | R/L3 | det | debt markers inventoried/tracked |
| `lint_config` | A/L1 | det | linter configured with real rules |
| `type_check` ⛳ | A/L1 | det | type-checker configured and clean |
| `formatter` | A/L1 | det | autoformatter configured |
| `strict_typing` | A/L2 | det, S | strict mode, no implicit-any |
| `naming_consistency` | A/L3 | det | naming conventions enforced |
| `dead_code_detection` | A/L3 | det | unused-export/unreachable analyzer clean |
| `duplicate_code_detection` | A/L3 | det | copy-paste detector under threshold |
| `unused_dependencies_detection` | A/L3 | det | unused declared deps flagged |
| `code_modularization` | A/L4 | det, S | import-direction analyzer |
| `cyclomatic_complexity` | A/L5 | det | per-function complexity capped |

### 5.3 Testing — 8, all A
Area: `test-layout`.

| id | scope/level | discovery | note |
|---|---|---|---|
| `unit_tests_exist` | A/L1 | agent[test-layout] | unit-test suite present |
| `unit_tests_runnable` ⛳ | A/L2 | det | test command runs *real* tests (not a no-op) |
| `test_coverage_thresholds` | A/L2 | det | coverage threshold configured AND enforced |
| `integration_tests_exist` | A/L3 | agent[test-layout] | tests across a real boundary |
| `test_naming_conventions` | A/L3 | agent[test-layout] | consistent discoverable naming |
| `test_performance_tracking` | A/L4 | agent[test-layout] | slow-test/timing surface |
| `test_isolation` | A/L4 | agent[test-layout] | parallel-safe, no shared mutable state |
| `flaky_test_detection` | A/L4 | agent[test-layout], S | retry/quarantine/flaky reporting |

### 5.4 Environment & Setup — 7, all R
Area: `setup-runnability`.

| id | scope/level | discovery | note |
|---|---|---|---|
| `env_template` | R/L1 | det | committed `.env`-style example |
| `gitignore_comprehensive` | R/L1 | det | comprehensive `.gitignore` |
| `deps_pinned` ⛳ | R/L2 | det | pinned versions + committed lockfile |
| `devcontainer` | R/L2 | det | dev-container config committed (presence) |
| `secrets_management` | R/L2 | agent[setup-runnability] | secrets via managed mechanism, not committed |
| `local_services_setup` | R/L2 | agent[setup-runnability], S | scripted one-shot local deps |
| `devcontainer_runnable` | R/L3 | agent[setup-runnability], S | dev-container would actually build (presupposes `devcontainer`) |

### 5.5 CI, Release & Deployment — 14 (13 R + 1 A), all det

| id | scope/level | flags | note |
|---|---|---|---|
| `vcs_cli_tools` ⛳ | R/L2 | det | authenticated VCS-platform CLI available |
| `monorepo_tooling` | R/L2 | det, S | workspace/monorepo config |
| `dependency_update_automation` | R/L2 | det | bot/scheduled update PRs |
| `release_notes_automation` | R/L3 | det | changelog/release-notes generation |
| `release_automation` | R/L3 | det | automated release/deploy pipeline |
| `version_drift_detection` | R/L3 | det, S | version-sync across packages |
| `dead_feature_flag_detection` | R/L3 | det, S | stale-flag detection |
| `feature_flag_infrastructure` | R/L4 | det | feature-flag system configured |
| `fast_ci_feedback` | R/L4 | det, S | CI under ~10 min |
| `build_performance_tracking` | R/L4 | det, S | build timing/caching/metrics |
| `deployment_frequency` | R/L4 | det, S | ships multiple times/week on an automated path |
| `progressive_rollout` | R/L4 | det, S | canary/percentage/ring deploys |
| `rollback_automation` | R/L4 | det, S | fast documented rollback |
| `pre_commit_hooks` | A/L2 | det | committed pre-commit hook setup |

### 5.6 Observability — 12, all A, all det

| id | scope/level | flags | note |
|---|---|---|---|
| `structured_logging` ⛳ | A/L2 | det | structured logging library/module |
| `error_tracking_contextualized` | A/L2 | det | error tracker w/ stack/context |
| `distributed_tracing` | A/L3 | det | trace/request-id propagation |
| `metrics_collection` | A/L3 | det | metrics/telemetry pipeline |
| `alerting_configured` | A/L3 | det | alerting rules notify on-call |
| `product_analytics_instrumentation` | A/L3 | det | product-analytics SDK |
| `health_checks` | A/L3 | det, S | liveness/readiness |
| `deployment_observability` | A/L4 | det | deploy-impact dashboards |
| `code_quality_metrics` | A/L4 | det, S | coverage/complexity tracked over time |
| `circuit_breakers` | A/L4 | det, S | resilience for external calls |
| `profiling_instrumentation` | A/L4 | det, S | APM/continuous profiler |
| `error_to_insight_pipeline` | A/L5 | det | error tracker ↔ issue tracker |

### 5.7 Security & Data — 12 (5 R + 7 A), all det

| id | scope/level | flags | note |
|---|---|---|---|
| `branch_protection` | R/L2 | det, S | branch-protection/ruleset |
| `automated_security_review` | R/L2 | det, S | SAST/dependency-audit |
| `secret_scanning` | R/L3 | det, S | secret-scanning in CI/pre-commit |
| `min_release_age` | R/L3 | det | dependency release-age delay gate |
| `privacy_compliance` | R/L4 | det, S | consent/retention/DSR/anonymization |
| `database_schema` | A/L2 | det, S | schema-definition files |
| `api_schema_docs` | A/L3 | det, S | OpenAPI/typed/GraphQL schema doc |
| `pii_handling` | A/L3 | det, S | PII detection/masking |
| `log_scrubbing` ⛳ | A/L3 | det | log redaction/sanitization |
| `dast_scanning` | A/L4 | det, S | DAST against running app |
| `n_plus_one_detection` | A/L4 | det, S | N+1 / slow-query analysis |
| `heavy_dependency_detection` | A/L4 | det, S | bundle/size analysis |

### 5.8 Process & Collaboration — 7, all R

| id | scope/level | discovery | note |
|---|---|---|---|
| `codeowners` ⛳ | R/L2 | det | code-ownership map |
| `issue_templates` | R/L2 | det | committed issue templates |
| `issue_labeling_system` | R/L2 | det | deliberate labeling scheme |
| `pr_templates` | R/L2 | det | committed PR/MR template |
| `automated_pr_review` | R/L2 | det, S | bot/workflow first-pass review |
| `agentic_development` | R/L3 | agent[agent-config] | agents actively participate (instruction surface + co-author history) |
| `backlog_health` | R/L4 | det, S | backlog actively groomed |

### 5.9 Locality & Contracts — 8, all A, all det *(thesis category)*
"Maximize locality of reasoning, minimize invisible contracts," as enforced
lints. Stack-specific concepts (default export, `export *`, `any`) are **N/A**
where a language has no analogue.

| id | scope/level | flags | note |
|---|---|---|---|
| `machine_checked_architecture` | A/L4 | det, S | architecture as enforced import/layering constraints |
| `import_cycle_detection` ⛳ | A/L4 | det | acyclic import graph |
| `orphan_module_detection` | A/L3 | det | no whole unreachable files |
| `explicit_any_detection` | A/L3 | det, S | `any`-style escape hatch is a hard error |
| `strictest_type_checking` | A/L4 | det, S | beyond-baseline strict flags |
| `greppable_exports` | A/L3 | det, S | named exports only, no default exports |
| `barrel_file_reexport_detection` | A/L4 | det, S | no `export *` wildcard barrels |
| `mutation_testing` | A/L5 | det, S | mutation-score threshold |

**The 9 gates:** `single_command_setup`, `type_check`, `unit_tests_runnable`,
`deps_pinned`, `vcs_cli_tools`, `structured_logging`, `log_scrubbing`,
`codeowners`, `import_cycle_detection`.

**Counts:** 44 repo-scope + 46 app-scope = 90. Deterministic 70, agent 20.

---

## 6. Data shapes

### 6.1 Rubric records (authored data)

```yaml
# categories.yaml
- id: documentation            # snake_case
  title: Documentation         # Title Case
  description: >- one-paragraph scope statement

# repo-scope.yaml / app-scope.yaml entry
- id: agents_md
  category: documentation
  scope: repo | app
  level: 1..5
  skippable: false
  discoveryVia: deterministic | agent
  investigation: documentation | agent-config | setup-runnability | test-layout | null
  gate: false                  # reserved — not read by v0 scorer
  weight: 1                    # reserved — default 1, not read by v0 scorer
```

Validated by `src/rubric/schema.ts` (zod). Invariants enforced at load:
`investigation` non-null **iff** `discoveryVia: agent`; exactly one `gate: true`
per category; `weight > 0`; app-scope/repo-scope file matches each entry's
`scope`.

### 6.2 Scorecard entry (per criterion, per run)

```jsonc
{
  "<criterion_id>": {
    "numerator": 1,            // repo: 1|0 ; app: count of passing apps ; null = N/A
    "denominator": 1,          // repo: 1 ; app: N
    "rationale": "<= 500 chars, why it passed/failed/was N/A",
    "naKind": "not-applicable" // present only when numerator is null
                               //   | "no-detector"
  }
}
```

### 6.3 Report (per run)

```jsonc
{
  "repo": "warren",
  "rubricVersion": "0.2.0",
  "scoredAt": "2026-06-06T...Z",
  "commit": "bab5473b...",
  "level": 3,
  "passRate": 0.57,
  "coverage": 0.81,
  "apps": { "src/ui": { "description": "warren-ui" }, ".": { "description": "server" } },
  "criteria": { /* §6.2 entries */ },
  "drift": { /* §10 canonical-config drift, optional */ },
  "changesSinceLastRun": [ /* per-criterion deltas vs prior run, §11 */ ]
}
```

### 6.4 SQLite history (central state)

`bun:sqlite`. Minimal schema (migrations under `src/store/migrations/`):

```sql
-- one row per audit run
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL,          -- matches targets.yaml id
  commit_sha    TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  level         INTEGER NOT NULL,
  pass_rate     REAL NOT NULL,
  coverage      REAL NOT NULL,
  report_json   TEXT NOT NULL,         -- full §6.3 report
  scored_at     TEXT NOT NULL
);
CREATE INDEX runs_repo_time ON runs (repo, scored_at);

-- per-criterion rows for cheap drift/trend queries
CREATE TABLE criterion_results (
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  criterion   TEXT NOT NULL,
  numerator   INTEGER,                 -- nullable (N/A)
  denominator INTEGER NOT NULL,
  na_kind     TEXT,                    -- not-applicable | no-detector | NULL
  rationale   TEXT NOT NULL
);
CREATE INDEX cr_run ON criterion_results (run_id);

-- cached agent-investigation findings, keyed by content so re-runs are
-- deterministic unless code changed (see §7.3)
CREATE TABLE investigation_cache (
  repo        TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  area        TEXT NOT NULL,           -- one of the 4 investigation areas
  findings_json TEXT NOT NULL,         -- zod-validated facts (§7.2)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (repo, commit_sha, area)
);
```

### 6.5 `targets.yaml` (fleet + per-repo overrides)

The single declaration of the fleet. Because state is central, per-repo
**allowed deltas** for canonical drift live here too (not in the audited repos):

```yaml
defaults:
  canonicalVersion: "1.0.0"        # which standards/ version to compare against
targets:
  - id: warren
    path: /Users/jaymin/Projects/os-eco/warren
    languages: [typescript]         # optional hint; auto-detected if omitted
    canonical:
      version: "1.0.0"              # per-repo override of defaults.canonicalVersion
      allowedDeltas:                # files/keys this repo is allowed to diverge on
        - file: biome.json
          reason: "wider line width for generated migrations"
        - file: .github/workflows/ci.yml
          paths: ["jobs.test.strategy"]   # structural allow-list within a file
    skip: [dast_scanning]            # optional: force-N/A specific criteria
  - id: my-swift-app
    path: /Users/jaymin/Projects/strays/my-swift-app
    languages: [swift]
  - id: external-repo
    path: ../some-non-oseco-repo
    osecoDetectors: false            # disable os-eco-native detectors (§8.4)
```

---

## 7. Investigation layer (agent → facts → deterministic grade)

20 of 90 criteria are decided by judgment that "resists a glob" (what counts as
a test, does setup actually run, is the architecture documented). The discipline
that keeps the audit reproducible:

> The investigation step returns **objective findings**; a **deterministic
> grader** decides pass/fail from those facts.

### 7.1 The four fixed investigation areas

1. `documentation` — prose/docs layout, freshness, build-command presence,
   runbooks, architecture/flow docs.
2. `agent-config` — the agent-instruction surface (`AGENTS.md`/`CLAUDE.md`),
   skills (`*/SKILL.md`), agents-md validation automation, agent co-authorship.
3. `setup-runnability` — secrets handling, scripted local services, whether the
   devcontainer would actually build/start.
4. `test-layout` — where tests live, integration vs unit, naming, isolation,
   timing/flaky surfaces.

Each area runs **once per repo** (its findings feed every criterion bound to
it), keeping LLM calls bounded and cacheable.

### 7.2 Findings contract (`src/investigation/findings.ts`)

Each area returns a **zod-validated** facts object — *facts, never verdicts*.
Example shape (illustrative, finalized at implementation):

```ts
// agent-config area
const AgentConfigFindings = z.object({
  agentInstructionFiles: z.array(z.object({
    path: z.string(),
    hasScripts: z.boolean(),
    hasBuildTestCmds: z.boolean(),
    hasConventions: z.boolean(),
    hasWorkflow: z.boolean(),
  })),
  skills: z.array(z.object({ dir: z.string(), hasName: z.boolean(),
    hasDescription: z.boolean(), promptNonEmpty: z.boolean() })),
  validationAutomation: z.array(z.enum(
    ["ci-runs-commands","generator","pre-commit","doc-cmd-test","link-checker"])),
  agentCoAuthorshipCommits: z.number().int(),
});
```

The grader (`src/investigation/grader.ts`) is pure and deterministic: e.g.
`agents_md` passes iff some `agentInstructionFiles[i]` has all four booleans
true; `skills` passes iff ≥1 skill has name+description+non-empty prompt; etc.
**Same facts → same grade.**

### 7.3 Reproducibility & caching

Findings are cached in `investigation_cache` keyed by `(repo, commit_sha,
area)`. A re-run at the same commit reuses cached facts → byte-identical grade.
`--no-cache` forces re-investigation. (This makes the LLM nondeterminism a
one-time cost per commit, not a per-run coin flip.)

### 7.4 LLM execution — **Pi in RPC mode, see §9**

Findings are produced by a bounded **Pi** run per area (`pi --mode rpc`,
read-only tools, a `submit_findings` tool call carrying the facts) — fully
specified in §9. Everything downstream (grader, scoring, caching) depends only
on the **contract**: "given a repo checkout and an investigation area, return
facts that validate against that area's zod schema," so it stays
provider-agnostic and is exercised against golden fixtures with no live calls.

---

## 8. Detector layer (deterministic) & language adapters

### 8.1 Detector contract

```ts
interface DetectionContext {
  repoPath: string;
  app: { path: string; languages: Language[] };  // app-scope; repo-scope app = "."
  run: (argv: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
  readFile: (rel: string) => Promise<string | null>;
  glob: (pattern: string) => Promise<string[]>;
}
interface DetectorResult {
  numerator: number | null;   // pass=1 / fail=0 ; null = N/A
  denominator: 1;             // per-app unit; aggregator rolls up to N
  naKind?: "not-applicable" | "no-detector";
  rationale: string;          // <= 500 chars
}
type Detector = (ctx: DetectionContext) => Promise<DetectorResult>;
```

`src/detectors/registry.ts` binds each criterion id to a detector. Language
adapters provide the language-specific implementations; `common/` holds
language-agnostic ones (gitignore, env template, CI workflow presence,
CODEOWNERS, branch protection via VCS CLI, …).

### 8.2 App discovery (`src/discovery/`)

Before app-scope scoring: find **independently-deployable directories** as apps
(package manifests, build files, service dirs). If **0 found**, the repo root is
**1 app**. `monorepo_tooling` / `version_drift_detection` are skippable and
no-op for single-app repos. The app map is recorded in the report (§6.3).

### 8.3 Language adapters (all three in MVP)

The rubric is the tool-agnostic WHAT; adapters supply tools. A criterion with no
analogue in a language resolves to `not-applicable`. Representative bindings
(finalized at implementation):

| criterion | TypeScript | Swift | Python |
|---|---|---|---|
| `lint_config` | Biome | SwiftLint | ruff |
| `type_check` / `strict_typing` | tsc / `strict` | `swift build` (warnings-as-errors) | mypy / `--strict` |
| `formatter` | Biome | swift-format | ruff format / black |
| `unit_tests_runnable` | `bun test` | `swift test` | pytest |
| `test_coverage_thresholds` | coverage ratchet | `swift test --enable-code-coverage` | coverage.py |
| `dead_code_detection` | knip | periphery | vulture |
| `duplicate_code_detection` | jscpd | jscpd | jscpd / pylint dup |
| `unused_dependencies_detection` | knip | — (N/A) | deptry |
| `cyclomatic_complexity` | Biome complexity | SwiftLint complexity | radon / ruff |
| `greppable_exports` / `barrel_file_reexport_detection` / `explicit_any_detection` | TS-specific | N/A | N/A |
| `import_cycle_detection` | madge / knip | — | grimp / pydeps |
| `mutation_testing` | StrykerJS | muter | mutmut |

(Exact tool choices are an adapter implementation detail; the table records
intent, not a hard contract. Detectors must degrade to `no-detector` if a tool
is configured-for-but-unavailable, and `not-applicable` if the concept doesn't
exist for the language.)

### 8.4 os-eco-native detectors (`src/detectors/oseco/`)

So warren-stack repos score honestly, trellis recognizes os-eco conventions as
evidence for **existing** criteria (no new category). Active by default; per
target, `osecoDetectors: false` disables them. Mappings:

- `AGENTS.md` + `CLAUDE.md` → `agents_md` (rich agent instructions).
- `*/SKILL.md` (Factory/Droid skills) → `skills`.
- `.seeds/` present + labeling config → `issue_templates`,
  `issue_labeling_system`, `backlog_health` (via `sd` data).
- `check:all` script + CI invoking it (full-gate parity) → strong evidence for
  `unit_tests_runnable`, `pre_commit_hooks`, `fast_ci_feedback` inputs.
- Ratchet scripts (file-size / debt-marker / coverage / complexity / bundle /
  jscpd / knip) → `large_file_detection`, `tech_debt_tracking`,
  `code_quality_metrics`, `dead_code_detection`, `duplicate_code_detection`,
  `unused_dependencies_detection`, `heavy_dependency_detection`.
- `gen:openapi` / `docs/openapi.yaml` → `api_schema_docs`;
  `gen:docs` → `automated_doc_generation`.
- `canopy` (versioned prompt libraries) → `automated_doc_generation` /
  agent-config signal.
- `mulch` (`.mulch/`) → `documentation_freshness` / `agentic_development`
  evidence (cross-session expertise capture).
- `plot` (`.plot/`) → `agentic_development` / process coordination evidence.
- Agent co-authorship in git history (`factory-droid[bot]`, etc.) →
  `agentic_development`.

> Note: os-eco's memory (mulch), spec-first (SPEC.md), and prompt-library
> (canopy) strengths exceed what the current 90 criteria grade. We surface them
> as evidence today; a dedicated category for memory / spec-first / cost / evals
> is a deliberate post-MVP extension (§15).

---

## 9. LLM provider infra — **Pi in RPC mode**

The investigation layer's execution is a **bounded Pi run per `(repo, area)`**.
trellis mirrors the way warren and burrow drive Pi — spawn the `pi` CLI in RPC
mode and speak its newline-delimited-JSON protocol — but specializes it for a
one-shot, **read-only**, structured-fact extraction rather than an interactive
agent loop. The rest of trellis depends only on the contract from §7.4: *given a
repo checkout + an investigation area, return facts that validate against that
area's zod schema.* This section makes that contract concrete.

### 9.0 Where it sits (the api>cli>sdk core discipline)

Per §13.1, the provider is a **domain-core module** (`src/investigation/provider/`).
Nothing above core spawns Pi: both the CLI (`trellis audit`) and the typed SDK
reach investigation through the single core entrypoint

```ts
investigate(repoPath: string, area: InvestigationArea, opts?: InvestigateOpts)
  : Promise<Findings>   // facts only; zod-validated against the area schema
```

There is exactly one implementation of the Pi transport, so the CLI and SDK can
never disagree about how facts are produced. trellis has **no HTTP server** in
MVP — "api" here is the programmatic core surface (§13.1), not a network API.

### 9.1 Transport — `pi --mode rpc`

Mirror burrow's `buildPiArgv`. For each area, trellis spawns (cwd = the target
repo checkout, so read tools operate on the live files):

```
pi --mode rpc \
   --no-session \
   --no-extensions -e <trellis>/src/investigation/provider/pi/findings-extension.ts \
   --offline \
   --no-context-files \
   --provider <provider> --model <model> \
   --tools <read-only builtins>,submit_findings \
   --system-prompt <per-area investigation prompt>
```

Flag rationale (the load-bearing ones, mirroring burrow's documented findings):

- `--mode rpc` — the JSONL command/event protocol (identical to warren/burrow):
  one JSON command per `\n` on stdin, one JSON event per `\n` on stdout.
- `--no-session` — investigation is one-shot and ephemeral; trellis owns
  reproducibility through its own findings cache (§9.5), so Pi sessions/resume
  are unused.
- `--no-extensions -e <findings-extension>` — disable auto-discovery of the
  host's Pi extensions (hermetic; no surprise tools, no interactive
  `extension_ui_request` that would hang an unattended run) **while explicitly
  loading trellis's own extension** that registers the `submit_findings` tool.
  (Pi: explicit `-e` paths still load under `--no-extensions`.)
- `--offline` — skip startup network ops (telemetry/update polling); without it
  Pi stalls for minutes before reading stdin (burrow-029d). Deterministic start.
- `--no-context-files` — do **not** auto-load the target repo's
  `AGENTS.md`/`CLAUDE.md` into Pi's own system prompt: those files are *evidence
  trellis grades*, never instructions trellis obeys. trellis owns the prompt.
- `--tools <read-only builtins>,submit_findings` — an **allowlist**: Pi's
  read/search/list builtins plus the submission tool, and nothing that mutates
  (no bash/edit/write). This is the read-only mandate — an audit can never alter
  the repo it scores. Exact builtin tool names are pinned against the supported
  Pi version at implementation.
- `--provider/--model` — always pinned explicitly (Pi's own CLI default provider
  is `google`); values are fully configurable (§9.4).

### 9.2 The findings tool (`submit_findings`)

Pi has **no JSON-schema-constrained generation**, so structured facts are
obtained via a **tool call**, not by parsing free text. trellis ships a tiny Pi
extension (`findings-extension.ts`) that registers one tool:

- `submit_findings(findings)` — the `findings` parameter's JSON-schema is
  derived from the area's zod findings schema (§7.2) via `zod-to-json-schema`,
  so Pi is shown exactly the fact shape it must return. The tool handler merely
  acknowledges receipt; the **authoritative capture** is trellis reading the
  tool-call arguments off the RPC event stream.

The per-area system prompt instructs Pi to investigate the area with read-only
tools and then call `submit_findings` exactly once with the gathered facts —
**facts, never verdicts** (the pass/fail decision is the deterministic grader's,
§7.2).

### 9.3 Request / response flow

1. trellis writes one stdin line — `{"type":"prompt","message":"<area task>"}\n`
   — and **holds stdin open** (Pi exits the instant stdin closes, even
   mid-inference; burrow's load-bearing invariant).
2. trellis reads stdout JSONL events, watching assistant `message_end` content
   blocks for a `toolCall` whose `name === "submit_findings"`; its `arguments`
   is the candidate facts object.
3. On capture, trellis **zod-validates** the arguments against the area schema.
   Valid → those are the `Findings`; trellis closes stdin (Pi exits) and caches
   them (§9.5).
4. trellis otherwise stops at the terminal `agent_end` envelope.
5. **No tool call / validation failure:** trellis writes one corrective `prompt`
   echoing the zod errors and awaits a second `submit_findings`, bounded to `N`
   retries (default 2). Exhausting retries (or a timeout/error/`stopReason:error`)
   resolves that area to **`no-detector`** — counted against coverage (§3.2)
   with the failure rationale, **never a fabricated pass**.

Each area run is bounded by a heartbeat watchdog (mirroring warren's pattern);
a stalled or timed-out run is force-terminated by closing stdin and resolves to
`no-detector`.

### 9.4 Provider / model / env (configurable)

Mirror burrow's env conventions exactly, but keep provider/model fully
configurable (no hardcoded model in logic):

- **Selection precedence:** `--provider` / `--model` CLI flags > `targets.yaml`
  (`defaults.investigation.{provider,model}`, with per-target override) > one
  documented built-in default constant. Provider names are lowercased before
  lookup (case-insensitive, like burrow/warren).
- **Env passthrough (never argv):** API keys reach the Pi subprocess only via
  its environment. Base keys forwarded always:
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`. A
  provider-conditional `PI_PROVIDER_ENV_KEYS` map adds extras when a non-default
  provider is selected:

  ```ts
  const PI_PROVIDER_ENV_KEYS = {
    openai:   ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    google:   ["GEMINI_API_KEY"],   // pi reaches Gemini via provider "google"
    groq:     ["GROQ_API_KEY"],
    mistral:  ["MISTRAL_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
  } as const;
  ```

  No key is ever passed on argv (no `--api-key`); argv carries only
  `--provider` / `--model`.

### 9.5 Reproducibility & caching

Pi is nondeterministic; trellis freezes it per commit. Captured + zod-validated
findings are written to `investigation_cache` keyed by `(repo, commit_sha,
area)` (§7.3). A re-run at the same commit reuses cached facts → byte-identical
grade. `--no-cache` forces re-investigation. The LLM nondeterminism is thus a
one-time cost per commit, not a per-run coin flip.

### 9.6 Pi version & discovery

`pi` is discovered as a bare binary on `PATH` (operator-installed;
`@earendil-works/pi-coding-agent`). The RPC wire shape and the `toolCall`
envelope are version-sensitive (burrow pins v0.74.0), so trellis documents a
supported Pi version and probes it at startup via `pi --version` (mirroring
burrow's `installCheck`). A missing or incompatible Pi degrades **every** agent
criterion to `no-detector` with a clear hint — it never crashes the audit.

### 9.7 Testing — golden fixtures

Mirror burrow's golden methodology. For each area, capture one real
`pi --mode rpc` session (the full JSONL event stream, including the
`submit_findings` `toolCall`) into `src/investigation/__golden__/`, canonicalize
volatile fields (timestamps, `responseId`, session/tool-call ids, usage), and
freeze it. Unit tests then run the RPC parser → zod validation → the
deterministic grader against the frozen fixtures **entirely offline**: the
grader, scoring, drift, and CLI are fully buildable and testable with no live
provider. Live capture/regeneration is gated behind an env flag
(`TRELLIS_UPDATE_PI_GOLDEN=1`) plus an explicit live-call flag; **CI never makes
model calls.**

---

## 10. Canonical config drift (L1)

trellis bundles a canonical set of shared tooling files under
`src/standards/canonical/`, described by `src/standards/manifest.yaml`:

```yaml
version: "1.0.0"                 # semver of the canonical set as a whole
files:
  - path: biome.json
    version: "1.0.0"
    hash: "sha256:..."
    matcher: json-subset         # exact | json-subset | text | template
  - path: tsconfig.base.json
    version: "1.0.0"
    hash: "sha256:..."
    matcher: json-subset
  - path: .github/workflows/ci.yml
    version: "1.0.0"
    matcher: text
  - path: AGENTS.md
    version: "1.0.0"
    matcher: template            # template/section-aware, not byte-exact
  - path: scripts/hooks/pre-commit
    version: "1.0.0"
    matcher: text
  - path: .seeds/config.yaml
    version: "1.0.0"
    matcher: yaml-subset
```

`src/standards/drift.ts` compares each target file against canonical:

- The target declares which canonical `version` it tracks (per-repo override in
  `targets.yaml`, default `defaults.canonicalVersion`).
- **Allowed deltas** (`targets.yaml` → `canonical.allowedDeltas`) whitelist
  specific files or structural paths within a file; whitelisted divergences are
  reported as `allowed`, not `drift`.
- Output per file: `match | allowed-delta | drift | missing | extra`, folded
  into the report under `report.drift` and surfaced in the dashboard.

Canonical files are **semver'd** so a repo can declare "on canonical v1.0.0" and
roll forward deliberately. `standards/` lives **inside trellis** (single source
of truth, versioned with the tool).

---

## 11. Re-runs, drift & "changes since last run"

- Each `audit` writes a `runs` row + `criterion_results` rows.
- A re-run compares against the most recent prior run **for the same repo**:
  - Recompute every criterion; only emit deltas where the *code* changed
    (cached findings make agent criteria stable across runs at one commit).
  - `report.changesSinceLastRun` lists per-criterion transitions
    (pass→fail, N/A-kind changes, app-count changes) and the net level move.
- Because every run records `rubric_version`, a level change is attributable: if
  `rubric_version` differs, a level move may be a rubric change, flagged
  explicitly; if it's identical, the move is a real code regression/improvement.

---

## 12. CLI surface (CLI-only MVP)

`commander`-based. Human-readable terminal output by default; `--json` / `--md`
for machine/report output.

```
trellis audit <repo-path>            # score one repo; print scorecard
  [--json|--md] [--no-cache] [--rubric-version <v>] [--canonical <v>]
trellis drift <repo-path>            # L1 canonical-config drift only
trellis fleet                        # audit every target in targets.yaml
  [--targets targets.yaml] [--json|--md]
trellis report [--repo <id>]         # render history/dashboard from SQLite
  [--since <date>] [--json|--md]
trellis rubric                       # print the loaded rubric + version
  [--validate]                       # validate rubric data invariants (§6.1)
trellis standards                    # show canonical manifest + versions
```

Exit codes: `0` clean; non-zero when a gate criterion fails or drift is detected
(tunable via `--fail-on level|gate|drift|none`) so trellis is CI-usable per
repo.

---

## 13. Tech stack & conventions

Mirrors the warren/burrow stack so the operator's muscle memory transfers:

- **Runtime:** Bun (runs TS directly, no build step for the CLI).
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`).
- **Validation:** zod (rubric schema, findings schemas) — already the os-eco
  default.
- **Lint/format:** Biome, `--error-on-warnings`.
- **Storage:** `bun:sqlite`.
- **CLI:** commander; **logging:** pino.
- **Conventions:** kebab-case filenames, tab indent / 100-col, `.ts` import
  extensions, tests as `<name>.test.ts` beside the unit, golden fixtures under
  `__golden__/`. trellis should adopt the same quality-gate ratchets it audits
  for (eat-its-own-dogfood: it should score L4+ against itself).

### 13.1 api>cli>sdk core discipline

trellis follows the same anti-drift layering as warren, adapted to a CLI-only
tool: **all behavior lives in one surface-agnostic domain core, and every other
surface is a thin pass-through to it.** Because there is exactly one
implementation of each operation, the surfaces cannot drift out of sync.

- **Core (the "api").** The functional modules under `src/` —
  `rubric/`, `discovery/`, `detectors/`, `investigation/` (incl. the §9 Pi
  provider), `scoring/`, `standards/`, `fleet/`, `store/`, `report/` — hold *all*
  validation, scoring, drift, and investigation logic. No business logic lives
  anywhere else. This is the programmatic API surface; there is **no HTTP server**
  in MVP (a network API is a deferred surface over this same core, §15).
- **CLI (`src/cli/`).** Thin commander entrypoints that parse args, call core
  functions, and shape terminal/JSON/MD output. They never reimplement logic.
- **SDK (`src/client/`).** A typed programmatic client for driving trellis from
  scripts/other tools, whose request/response types **mirror the core's** exported
  types (annotated `// Mirrors src/<x>`). It calls the same core functions the CLI
  does (in-process), so a programmatic audit and a CLI audit exercise one code path.
- **Sync enforcement.** Single core implementation + strict `tsc` (no `any`,
  `noUncheckedIndexedAccess`) over the mirrored SDK types + golden snapshots of
  any stable output shapes, all wired into one `check:all` that CI runs verbatim.
  Drift becomes a red build, not a review judgment call. (If the deferred HTTP
  surface lands, it adopts warren's canonical `ROUTE_TABLE` → generated +
  CI-checked OpenAPI/docs pattern over the same core.)

---

## 14. MVP cut / milestones

1. **Rubric data + schema + validator.** `categories.yaml`, `repo-scope.yaml`,
   `app-scope.yaml`, zod schema, invariant checks, `RUBRIC_VERSION`. (`trellis
   rubric --validate` green.)
2. **Scoring engine.** Pass-rate, coverage clamp, `naKind` handling, repo/app
   aggregation, band → level. Pure + unit-tested against worked examples (§3.4).
3. **Deterministic detectors — TypeScript adapter + common.** Bind every
   deterministic, TS-applicable criterion; `not-applicable`/`no-detector`
   discipline. Run `trellis audit` on warren end-to-end (det-only).
4. **App discovery + Swift + Python adapters.** Multi-app scoring; Swift &
   Python deterministic detectors; N/A mapping for cross-language gaps.
5. **Investigation layer (against goldens).** 4 areas, findings zod schemas,
   deterministic grader, caching tables — all exercised on frozen fixtures.
   *(The §9 Pi-RPC execution layer plugs in behind the same contract; built and
   tested against frozen fixtures first, no live calls.)*
6. **Canonical standards + L1 drift.** `standards/canonical/` set, manifest with
   versions/hashes, `drift.ts`, allowed-deltas via `targets.yaml`.
7. **Fleet + SQLite history + report.** `targets.yaml` loader, `runs` /
   `criterion_results` / `investigation_cache`, `trellis fleet`, `trellis
   report` dashboard, changes-since-last-run.
8. **os-eco-native detectors.** §8.4 mappings, toggle per target.

Dogfood gate: trellis audits itself and the warren stack repos; iterate the
detector bindings on what actually mattered.

---

## 15. Deferred / open

- **L3 auto-fix via Warren fan-out.** The audit already produces a perfect
  Warren plan: `trellis fix --repo X` dispatches a Warren run per drifted repo
  ("bring this repo to canonical; here is the drift report; here are the
  canonical files"), each opening its own PR. Build after the read-only signal
  is trusted.
- **The four missing dimensions as a real category.** Cross-session memory
  (ADRs/decision logs/mulch), spec-first culture (specs before code),
  cost/token observability, and workflow-eval suites (testing prompts/skills).
  os-eco embodies these; a 10th category would let trellis grade them rather
  than only surface them as evidence (§8.4).
- **Weighted scoring & gate enforcement.** `weight`/`gate` fields are authored
  but unread; turning them on is comparability-affecting (major-ish), so it's a
  deliberate later rubric version.
- **Web dashboard.** A warren-style React surface over the SQLite history.
- **Adjacent ideas:** README score badges (`agentic-readiness: A`), kota-sense
  weekly drift briefings, auto-filing a seed when drift is detected,
  `.env.example` completeness / secrets-rotation freshness as criteria.

---

## Appendix A — provenance

- `../notes/readiness-report-prompt.md` — the original 82-criterion auditor
  (scoring formula, repo/app split, bands, re-run/baseline machinery).
- `../notes/ai-readiness-principles.md` — the 8 principles, ratcheting
  philosophy, failure-mode vocabulary (context starvation/poisoning,
  verification gap, tool poverty, spec drift, lossy handoff).
- `../notes/agent-readiness-business-brainstorm.md` — the
  "deterministic-core + LLM-only-for-fuzzy" split.
- `../notes/PRIVATE-rubric/` (day-job, de-branded) — v0.2.0: 9 categories / 90
  criteria, the Locality & Contracts category, versioned rubric, coverage-aware
  leveling, `naKind` split, reserved `gate`/`weight`, deterministic + 4
  investigation-area split, tool-agnostic WHAT + per-language adapters. Adopted
  here as a clean-room reimplementation (no verbatim code/data copied).
- burrow `pi` (`../burrow/src/runtime/pi.ts`, `provider/types.ts`) — reference
  for the LLM provider infra to be specified in §9.
