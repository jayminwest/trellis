# Trellis

## Keep growing codebases maintainable.

Trellis measures structural debt in TypeScript codebases. It finds complex
functions, duplicated code, and import cycles, shows where they accumulate,
and tracks what changes between audits.

Run it against a local directory. Get a sloppiness index, ranked hotspots,
and the measurements behind every score contribution. Audits run offline,
without model calls or project setup.

**[Quickstart](#quickstart)** · **[Compare changes](#compare-changes)** · **[Documentation](#documentation)**

## When the code gets harder to change

A refactor spans more files than expected. Similar logic starts appearing in
several places. Modules depend on each other in both directions. The codebase
still builds, but working in it takes more effort.

Trellis gives you a repeatable way to locate that structural debt and see
whether a change improves it. Use it before a refactor, during review, or in
CI to enforce the limits your project chooses.

It works on files as they exist on disk, including uncommitted changes and
directories outside Git.

## What trellis measures

- **Complexity.** Functions with many decision paths or deeply nested logic.
- **Structural erosion.** How much function mass is concentrated in complex functions.
- **Duplication.** Repeated code, including copies with renamed identifiers and literals.
- **Import cycles.** Groups of modules connected by circular dependencies.
- **Safeguards.** How hooks and quality checks are configured and connected, reported separately from the score.

The headline is a **0–100 sloppiness index. Lower is better.** Each
contribution traces back to raw measurements. Findings include file locations
so you can inspect the code behind them.

The index measures production code. Test code is analyzed separately, and
safeguard configuration never offsets structural debt.

Optional pinned tools add unscored clone and declared architecture evidence.
See the [quality-evidence guide](docs/quality-evidence.md) for setup, policy,
compatibility and supported-platform limits.

## Quickstart

Requires [Bun](https://bun.sh) 1.1 or later.

Install from source:

```bash
git clone https://github.com/jayminwest/trellis
cd trellis
bun install
bun link
```

Audit a TypeScript workspace:

```bash
trellis audit /path/to/project
```

The audited project needs no configuration, credentials, Git repository, or
installed dependencies. A default audit prints its report and writes nothing.

Choose JSON or Markdown when you need to keep or share the result:

```bash
trellis audit . --json --out report.json
trellis audit . --md --out report.md
```

`--out` writes the report to the file instead of stdout. A confirmation goes
to stderr; add `--quiet` to suppress it.

## Compare changes

Capture a baseline, make your changes, then audit again:

```bash
trellis audit . --json --out /tmp/before.json

# Make your changes.

trellis audit . --json --baseline /tmp/before.json
```

A supplied baseline enables score-regression and new-finding policy checks.
To inspect index changes, metric deltas, and new/resolved/persistent findings,
save the current report and compare the artifacts:

```bash
trellis audit . --json --out /tmp/after.json
trellis compare /tmp/before.json /tmp/after.json
```

Named hotspots keep their identity across comment and line shifts; replacing
a function or adding the same method name in another class creates a new
hotspot. Anonymous or duplicate identities remain conservative new/resolved
pairs. Analyzer 0.2.3 emits schema 1.2.0 and uses bounded suffix-array duplication
analysis. Historical reports remain readable; crossing either the identity or
native-engine transition requires a fresh baseline. Scoring and the 100-token /
3-line clone thresholds are unchanged. See the
[identity and compatibility rules](docs/hotspot-identity.md) and
[native engine acceptance](docs/research/native-duplication/acceptance.md).

## Guide an agent through cleanup

Ask your agent: **Run `trellis guide cleanup` and follow it until no clearly
justified improvements remain.** The bundled guide describes the cleanup workflow;
repository-specific constraints stay in your repository instructions.

```bash
trellis guide cleanup
```

Reading the guide writes nothing and starts no audit or agent. The same canonical
content is available as `guide("cleanup")` from `@os-eco/trellis-cli/client`, or
as `{ name, content }` with `trellis guide cleanup --json`. Markdown output uses
`--md`. The maintained source is [src/guides/cleanup.ts](src/guides/cleanup.ts);
workflow documentation should reference it rather than copy its instructions.

## Set your project's limits

Add an optional `trellis.yaml` to declare the conditions that fail an audit:

```yaml
policy:
  maxIndex: 40
  regression:
    maxIncrease: 2
  failOnNew:
    - import-cycle
```

With a baseline, this policy also rejects an index increase above two points
or a new import cycle.

Trellis exits `0` when policy passes, `2` when policy fails, and `1` when it
cannot run. A policy failure still emits the report, so CI retains the
evidence behind the failed check.

Policies set acceptance limits. The scoring formula stays consistent across
projects.

## Track a repository or a fleet

Keep local history when you want to follow a codebase over time:

```bash
trellis audit . --history
trellis report
```

History lives centrally in `~/.trellis/trellis.db`.

For multiple repositories, declare targets and run the same audit across
all of them:

```bash
cp targets.yaml.example targets.yaml
trellis fleet --history
```

Each target keeps its own report and policy result. Canonical configuration
drift is available as a separate inspection.

## Use it from TypeScript

The SDK calls the same audit core as the CLI:

```ts
import { audit } from "@os-eco/trellis-cli/client";

const result = await audit("/path/to/project");

console.log(result.report);
if (result.policy.failed) process.exitCode = 2;
```

Local audits, SDK calls, fleet runs, and CI use the same measurement and
policy logic.

## Scope and limits

Trellis currently analyzes TypeScript and TSX. Other languages and excluded
files are reported as coverage boundaries.

Audits never execute the project's tests, builds, linters, or hooks.
Safeguard findings describe configuration and wiring; they do not establish
that those checks pass.

Missing dependencies can limit import resolution. Parse failures and
analysis limits remain visible. An incomplete required scoring dimension
receives its full score contribution and marks the headline partial.

The scoring formula is provisional. The index is a weighted measure of
structural debt, not a percentage of bad code. Compare reports with
compatible analyzer, scoring, and configuration identities.

## Documentation

- [CLI reference, configuration, and CI workflows](docs/cli-reference.md)
- [Metrics, scoring, and known limitations](docs/metrics-and-scoring.md)
- [Product contract and configuration](SPEC.md)
- [Architecture](docs/architecture.md)
- [Corpus validation](docs/corpus-validation.md)
- [Scoring calibration](docs/count-calibration.md)
- [Release acceptance and known limitations](docs/release-acceptance.md)
- [Release and operations runbook](RUNBOOK.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Part of os-eco

Trellis is the code-health measurement tool in
[os-eco](https://github.com/jayminwest/os-eco). It works independently and
needs no other ecosystem tool.

## Status

Pre-1.0. The deterministic audit, baseline comparison, declarative policies,
optional history, and fleet workflows are implemented. Trellis audits its
own codebase.

The scoring formula remains provisional while calibration continues.

## License

[MIT](LICENSE).
