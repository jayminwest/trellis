# CLI and workflow reference

[Back to the README](../README.md)

## Usage

`commander`-based; human-readable terminal output by default, `--json` /
`--md` for machine/report output.

```bash
trellis audit <path>               # measure + score one workspace; print the sloppiness report
  [--json|--md] [--out <file>]     #   artifact: .json/.md inferred from the extension
  [--baseline <report.json>]       #   compare against a saved report (§9)
  [--config <file>]                #   explicit trellis.yaml (default: discovered at the root)
  [--provider <id[:mode]>]         #   optional evidence provider, repeatable (§16.4)
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

### Optional evidence providers (`--provider`, SPEC §16.4)

`--provider <id[:mode]>` selects an optional quality-evidence provider —
repeatable, and advisory/unscored: it adds namespaced evidence alongside the
authoritative native measurement and never changes the sloppiness index.
Today the supported ids are `jscpd` (needs a match mode:
`--provider jscpd:exact|normalized|near`), `dependency-cruiser`, `knip` and
`sonarjs` (the latter three resolve to located `unsupported` evidence until
their adapters ship). A flag applies **per provider** over the `providers`
block of `trellis.yaml`: a flagged provider uses the flag's request,
providers not flagged keep their file entry. The pinned tool must already
be installed locally where trellis resolves from (see
[provider-tools.md](provider-tools.md)) — trellis never installs or fetches
tools at audit time — and an enabled external analysis runs over isolated
temporary scratch storage trellis owns and cleans up; a native-only audit
creates none. A provider that cannot run is located evidence (`unavailable`
/ `unsupported`), never an abort — and `policy.requireEvidence` in
`trellis.yaml` turns a required-but-missing provider into exit `2`.

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
trellis audit . --json --baseline /tmp/before.json --out /tmp/after.json
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

Once the package is published, pin the analyzer version (report comparability is versioned, SPEC §3.5),
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
