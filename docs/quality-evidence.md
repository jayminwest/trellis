# Optional quality evidence

A default `trellis audit /path/to/project` runs native structural analysis.
It needs no Git, credentials, target dependencies or optional tool. The
0–100 sloppiness index remains exclusively native; lower is better.

Optional providers add located evidence without changing that score:

| Provider | Selection | Interpretation |
| --- | --- | --- |
| jscpd 5.2.1 | `jscpd:exact`, `jscpd:normalized`, `jscpd:near` | Clone evidence with trellis-owned line accounting |
| dependency-cruiser 18.3.1 | Declarative rules below | Violations of the rules you declare |
| SonarJS | `sonarjs` | Unsupported under the recorded [deferral](sonarjs-decision.md); clearance tracked by `trellis-7f5d` |
| Knip | Declarative reachability context | Adapter delivery and final verification tracked by `trellis-8ebc` |

## Prepare tools separately

For a source checkout, install the locked dependencies once:

```bash
bun install --frozen-lockfile
bun run smoke:provider-tools
```

Preparation may use the network. Audits never install or download tools.
For an installed CLI, prepare the exact tool in the CLI installation's
package tree, not in the audited project; see [provider-tools.md](provider-tools.md).
Provider availability follows the manifest's OS/CPU entries. Current
macOS ARM64 acceptance and the explicit untested-platform gaps are recorded
in [provider-acceptance.md](provider-acceptance.md).

## Select and require evidence

```bash
trellis audit /path/to/project --provider jscpd:normalized --json
trellis audit /path/to/project --provider jscpd:near --md --out evidence.md
```

Richer requests live in the project's `trellis.yaml`:

```yaml
providers:
  jscpd:
    mode: exact
  dependency-cruiser:
    rules:
      - kind: boundary
        name: domain-does-not-import-ui
        allowance: forbidden
        edges: [runtime]
        from: {path: '^src/domain/'}
        to: {path: '^src/ui/'}
      - kind: cycle
        name: runtime-cycles
        edges: [runtime]
policy:
  requireEvidence: [dependency-cruiser]
```

An advisory execution failure is visible evidence and ordinarily exits 0.
Requiring an absent, incomplete, unavailable or unsupported analysis exits
2 with a report. Invalid configuration exits 1. Requirements name analysis
ids such as `jscpd`, not namespaced metric ids. Requesting SonarJS is valid;
requiring it fails policy while its deferral remains in force.

Native `score.partial` and report `completeness` describe the scoring basis.
The separate `evidence.completeness` can be incomplete while the score is
complete. Never interpret an unavailable provider as zero findings.

## Save, compare and use the SDK

```bash
trellis audit /path/to/project --json --out before.json
trellis audit /path/to/project --json --out after.json
trellis compare before.json after.json --json
```

```typescript
import { audit, compare, fleet } from "@os-eco/trellis-cli/client";

const result = await audit("/path/to/project"); // reads the same trellis.yaml
const comparison = await compare("before.json", "after.json");
const members = await fleet("targets.yaml");
if (result.report.schemaVersion === "1.1.0") {
  console.log(result.report.evidence, comparison, members);
}
```

The report is a versioned union; TypeScript consumers should narrow
`result.report.schemaVersion === "1.1.0"` before accessing `evidence`.
Fleet uses each target's configuration and the same policy assessment:

```yaml
targets:
  - id: application
    path: /path/to/project
```

```bash
trellis fleet --targets targets.yaml --json
trellis audit /path/to/project --history --db history.db
```

Old schema 1.0.0 reports remain readable. Missing provider evidence means
unrequested. Schema 1.1.0 carries pinned tool/adapter identity, parser,
options, selected file fingerprints and observed coverage. Provider version,
options or scope changes can make that evidence noncomparable without
fragmenting compatible native score history. Changed source contents are
the subject of a trend, explicitly caveated; they are not automatically an
incompatible measurement. Native analyzer/scoring changes still fail closed.

## Interpret scope and trust

Clone pairs, equivalence groups and raw tool percentages are different
quantities. Near similarity is not transitive. Native and jscpd totals may
differ; jscpd never replaces native scoring. Architecture evidence covers
declared rules and distinguishes type-only and runtime edges; an empty
violation list does not prove overall architectural quality.

Knip's declared entries, public surfaces and test-root participation define
the reachability question. Missing context cannot establish dead code.
Plugin discovery is disabled, and candidates remain advisory. Its adapter
is not included in this document's executed acceptance claim yet.

Enabled tools receive a source snapshot in owned temporary storage, with
cleanup and execution/output bounds. Native audits create no trellis scratch.
No target scripts, executable target configuration, model, arbitrary command
string or audit-time installer is accepted. A prepared local tool installation
is trusted; this is controlled execution, not a general untrusted-code
sandbox. Bun may maintain its own transpiler cache; set
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` when measuring process-wide writes.

This profile adds no composite quality score, co-change mining, target
verification execution or remediation. See [SPEC §16](../SPEC.md#16-optional-quality-evidence-providers-integration-contract--plan-pl-43c5)
for the contract and the acceptance record for exact tested commands.
