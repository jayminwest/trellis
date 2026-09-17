# Architecture provider spike

Bounded provider experiment for trellis-ff55. No production integration or score change.

## Reproduce

Requires Node (tested v24.16.0), root dependencies installed with the repository lockfile,
Knip **6.16.1**, and the shared `../provider-spike-corpus.json` manifest. The runner
verifies all 162 production content hashes before analysis. Corpus digest:
`420cdd12431c6c4e1badeb13917c39a4d9da02a6ab6cfb2ca3e801db4379a848`.

Install the optional toolkit without executing install scripts:

```sh
mkdir -p /tmp/trellis-architecture-tools
cp docs/research/architecture-provider-spike/provider-package.json /tmp/trellis-architecture-tools/package.json
cp docs/research/architecture-provider-spike/provider-package-lock.json /tmp/trellis-architecture-tools/package-lock.json
npm ci --prefix /tmp/trellis-architecture-tools --ignore-scripts --no-audit --no-fund
node docs/research/architecture-provider-spike/run.mjs
```

`TRELLIS_ARCH_TOOLS` overrides the toolkit directory. Network is needed for installation,
not analysis. Fixtures/config are generated under the OS temporary directory. Each
provider runs twice on each target. `summary.json` records exact argv, exit status,
versions, repeat comparisons and SHA-256 of normalized evidence. Raw JSON artifacts
retain provider ordering; paths to the checkout/tools/temp directory are replaced by
stable placeholders. Knip's normalized evidence additionally sorts file issue records.
Temporary directories are retained for debugging; the runner never loads executable
project configuration deliberately or invokes target project scripts.

The package lock pins dependency-cruiser **17.3.8** and its optional TypeScript parser
**5.9.3**. This differs from trellis core's TypeScript **6.0.3**. TS6-specific syntax and
resolution are not validated by this experiment. Knip uses its own installed analysis
stack from the repository lockfile. It is not using dependency-cruiser's TS parser.

## Results

| Target | dependency-cruiser | Knip |
| --- | --- | --- |
| Labeled fixture | 2 cycles (runtime and type-only), 1 forbidden boundary, 1 unresolved import | 1 unused file, 3 unused exports, 1 unresolved import |
| Trellis production | All 162 source files represented; 176 nodes including external/builtin stubs; no rule violations | 0 unused files, 258 export candidates, 181 type candidates, 0 unresolved imports |

The small fixture includes positive cases and negative controls: allowed domain/shared
import, used export, reachable cycle members, literal dynamic import, and public entry
exports. The runner asserts the complete expected selected-category finding sets, not
just counts, and fails on an empty provider graph or a missing production node. This
is successful detection on one constructed fixture, **not an estimate of real-world
precision/recall**. Type-only and runtime cycles are both reported here, with the
provider's dependency types preserved; they must not be merged into a runtime cycle
penalty. Runtime-only policy would need a distinct tested rule configuration.

Repeated normalized findings match. An additional rerun exposed nondeterministic Knip
file-record ordering; sorting those records is necessary for stable report bytes.
`rawRepeatIdentical` captures whether the latest pair happened to have the same order.

## What the configuration means

Both providers get generated JSON configuration. dependency-cruiser has three rules:
cycles, unresolved imports, and domain-to-UI prohibition. In trellis the latter is an
explicit experimental boundary from audit/metrics/scoring/compare into cli. A zero
means no violation of these three rules, not architectural coherence. It resolves
installed external dependencies but does not follow `node_modules` bodies.

Knip's project set is exactly the production manifest; entry files are the public
package/client indexes, CLI entry and every production script. Tests are not entry
points, and entry exports are not classified unused. Every plugin in Knip's runtime
plugin registry is explicitly disabled, preventing automatic framework/tool config
loading. This deliberately sacrifices framework-specific accuracy. JSON tsconfig and
package manifests, installed dependencies, package entry conventions and Knip's
resolver still affect results. This is not a proof of safe execution against arbitrary
untrusted repositories, nor a no-installed-dependencies experiment. A product adapter
needs a separate read/execution boundary audit and absent-dependency controls.

Manually inspected candidates show why these findings cannot be scored as needless code:

- `src/report/audit-fixtures.ts:auditFixture` is imported by client/fleet tests. Tests
  are excluded here, so “unused in this production reachability model” does not mean
  globally unused.
- `src/report/assess.ts:activeChecks` is directly exercised by `assess.test.ts`.
- `src/audit/index.ts:orderFindings` is an unused barrel re-export in the selected
  graph; the implementation remains used by report assembly. Removing a barrel export
  is a public/deep-import API decision, not proof the function should be removed.

No automatic removal or quality penalty is justified for the 439 symbol candidates.

## Existing graph versus adoption

Trellis already has deterministic TS import resolution and cycle measurement over its
shared syntax inventory, retaining type-only edges separately, recording externals
without resolving into packages, and marking unresolved local imports incomplete.
See `src/metrics/analyze-graph.ts` and `graph-types.ts`. This provider experiment does
not establish dependency-cruiser as a more accurate replacement. Its additive value
is configurable architectural rule validation and established reporting tooling;
its import/resolution semantics, parser version and external-node counting differ.

Knip contributes genuinely new export/file reachability evidence, but requires an
explicit application/entry-point model. A useful integration is an opt-in advisory
report with provider version, configuration, scope and located findings. The default
zero-setup audit should continue reporting missing context rather than treating missing
entry declarations or dependencies as quality defects.

## Failed probes that improved the harness

1. dependency-cruiser without its optional TS parser exited successfully with zero
   modules. The harness now pins a supported parser and asserts nonempty/full coverage.
2. Knip's published static JSON schema listed two plugin keys rejected by its runtime
   config validator. Disabling the actual installed runtime registry avoids the mismatch.
3. On macOS, a fixture root under `/var` while resolved paths were under `/private/var`
   caused imported files to appear orphaned. Canonicalizing the temporary root with
   `realpath` eliminated those false positives; negative controls now guard this.
4. An initial src-only entry model omitted research scripts and made their modules
   appear orphaned. Adding the shared production script entries removed those findings.

These failures make scope, parser support and path normalization part of the measurement
contract, rather than incidental installation details.
