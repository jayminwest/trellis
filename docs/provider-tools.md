# Supported provider tools: pinned artifacts and local resolution

**Status: delivered (`trellis-ff52`, plan `pl-43c5` step 11).** This page
documents how trellis pins, discovers, and verifies the external
quality-evidence provider artifacts it may execute — without ever
installing, updating, or downloading anything at audit time (SPEC §16.4
"Trust boundary — supported installation").

Native analysis and scoring stay the default and the authoritative basis.
Optional providers are opt-in, unscored evidence; an absent tool never
changes a native audit (a default `trellis audit` never touches this
machinery at all).

The bounded conformance and failure-regression record for the jscpd
adapter and its normalization — expected evidence, forced failure states,
repeat/runtime/memory observations, and retained leads — is
[`jscpd-conformance.md`](jscpd-conformance.md) (trellis-b0ec).

## Where the manifest lives

- `src/providers/manifest.ts` — the supported-tool manifest: one entry per
  pinned external tool with the exact package version, the bin layout, the
  SHA-256 digests of the pinned distribution's cross-platform files, and the
  declared platforms with their honest execution records.
- `src/providers/resolve.ts` — the local resolver: discovers an installed
  tool, verifies it against the manifest, and returns a located outcome —
  a verified executable path, or `unavailable`/`unsupported` with an
  actionable reason and install instructions.
- `src/providers/process.ts` — the controlled process runner's executable
  registry resolves `jscpd` through this manifest (`requirePinnedToolExecutable`);
  execution itself stays behind the step 9 limits (fixed argv, no shell,
  explicit environment, wall-time/output bounds).

## What is pinned

**jscpd 5.2.1** (`providerId: jscpd`) — the duplication-evidence candidate.
The pin records:

- the npm package identity (`jscpd` at exactly `5.2.1` — no ranges),
- the expected `bin.jscpd` entry (`./run-jscpd.js`),
- SHA-256 digests of the two cross-platform files the package ships
  (`run-jscpd.js`, `platform-map.js`), recorded from the real npm
  distribution,
- the platform packages (one per OS/CPU/libc, e.g. `jscpd-linux-x64-gnu`)
  with the binary path (`bin/jscpd`, `bin/jscpd.exe` on Windows), and
- a per-platform execution record (see below).

**dependency-cruiser 18.3.1** (`providerId: dependency-cruiser`, plan
`pl-43c5` step 22 — trellis-adbf) — the architecture-evidence adapter's
pinned tool. A **pure-JavaScript** distribution: its "binary" is the
launcher script `bin/dependency-cruiser.mjs`, so

- the pin records the launcher digest plus the package manifest's digest
  (the tool ships no platform map — the package manifest is the second
  cross-platform identity file),
- the declared platform's "platform package" is the tool package itself
  (there is nothing platform-specific to resolve), and the adapter runs
  the launcher under **trellis's own runtime** through the controlled
  process runner — never a PATH lookup, never `node`/`bunx`, with an
  owned minimal environment (`HOME` inside the owned scratch: the tool
  resolves its global configuration through the home directory), and
- the tool reads TypeScript through the compiler it resolves locally; the
  adapter resolves and **records that compiler's version** in analysis
  identity before anything runs — a missing or mismatched parser produces
  a successful empty graph (the research record,
  `docs/research/architecture-provider-spike`), so the adapter refuses to
  run blind and the coverage check keeps an empty graph `incomplete`.

For dependency-cruiser 18.3.1: **linux-x64-gnu** and **darwin-arm64** are
`tested` (the adapter's conformance and failure-regression suites plus the
provider smoke). The [macOS acceptance record](provider-acceptance.md) names
the exact runtime and verified launcher digest. No other platform is
declared: the distribution is JavaScript, but trellis claims only what it
exercised. Shared launcher packages must match both the launcher path and
its verified digest across host entries.

**Knip 6.16.1** (`providerId: knip`, plan `pl-43c5` step 24 — trellis-8ebc)
— the contextual reachability-evidence adapter's pinned tool. Like
dependency-cruiser it is a **pure-JavaScript** distribution, and it ships
a dedicated **Bun launcher** (`bin/knip-bun.js`) — the artifact the pin
verifies and executes under trellis's own runtime through the controlled
process runner (`src/providers/knip/invocation.ts`), never a PATH lookup.
The pin reuses the exact devDependency this repository's own `check:deps`
gate already installs — never a second copy. The adapter additionally:

- derives the runtime **plugin registry's names** from the pinned
  artifact's own registry file (a static read of a digest-verified
  distribution file — never imported or executed) and disables every
  plugin, so no framework/tool configuration or entry convention can
  reach the declared reachability model;
- resolves and **records the `oxc-parser` version** the tool finds locally
  in analysis identity (Knip's manifest pins a range, so the exact parser
  is a property of the prepared installation), refusing to run blind;
- generates the tool configuration from the prepared reachability context
  into owned scratch — the declared roots as `entry`, the production
  candidate scope as `project`, a generated minimal tsconfig, and a
  generated minimal workspace manifest written into the staged tree
  (trellis-owned scratch — the target's own manifests and `knip`
  configurations are never loaded); and
- neutralizes the findings exit code and promotes configuration hints to
  errors, so the exit status carries the tool's coverage signal: a hint
  means an empty or partial analysis, located `incomplete` — never a
  clean pass, and zero candidates never proves overall quality.

For Knip 6.16.1: **linux-x64-gnu** and **darwin-arm64** are `tested`
(conformance and failure-regression suites plus provider smoke). The
[combined acceptance record](provider-acceptance.md) records macOS execution
with oxc-parser 0.133.0 and all 155 runtime plugins disabled. Other hosts
remain undeclared; JavaScript distribution alone does not prove support.

## Preparing an installation (operator step, never audit-time)

trellis never installs, updates, or downloads tools. The supported
execution context is a **local installation prepared by the operator**:

- **In this repository** the pin is an exact devDependency
  (`"jscpd": "5.2.1"` in `package.json`), so `bun install` prepares the
  exact artifact offline from `bun.lock`. The dups gate and the provider
  smoke (`bun run smoke:provider-tools`) then resolve it locally.
  The dependency-cruiser pin is prepared the same way
  (`"dependency-cruiser": "18.3.1"`), alongside the repository's own
  `typescript` install the tool resolves as its parser. The knip pin is
  prepared the same way (`"knip": "6.16.1"`) — the exact devDependency
  the repository's own `check:deps` gate uses.
- **For a CLI install**, prepare the tool in the `node_modules` tree trellis
  itself resolves from, e.g. in the package that depends on
  `@os-eco/trellis-cli`:
  `npm install --save-exact --save-dev jscpd@5.2.1`
  (or `bun add --dev jscpd@5.2.1`); likewise
  `npm install --save-exact --save-dev dependency-cruiser@18.3.1` and
  `npm install --save-exact --save-dev knip@6.16.1`.

A request for a tool that is not installed resolves to `unavailable` with
these instructions attached (SPEC §16.2/§16.3) — never a fabricated run and
never an audit-time acquisition.

## Discovery and the trust boundary

Resolution walks the `node_modules` chain **upward from trellis's own
module location** — the operator-prepared installation trellis runs from.
It never:

- searches `PATH` or runs `bunx`/`npm exec` (no opportunistic downloads),
- accepts a target-workspace, operator-supplied, or command-string path,
- installs, updates, or downloads anything, or
- executes the tool during resolution.

Before a resolved artifact may run, it is verified against the manifest:
package name, **exact** version, bin layout, distribution file digests,
platform-package identity and version, binary presence, and — where a real
host produced one — the platform binary's digest. Any mismatch is a
located `unavailable` result; trellis never silently uses a different
version than the pin.

## Platform support, honestly

Every declared platform carries an execution record:

| Record | Meaning |
| --- | --- |
| `tested` | installed and invoked offline by this step's package smoke on that host (`scripts/smoke-provider-tools.ts`, also exercised by `src/providers/resolve.test.ts` in CI) |
| `research-tested` | installed and invoked by the research spike, with the binary digest recorded from that host (`docs/research/jscpd-provider-spike/summary.json`) |
| `declared-untested` | shipped by the pinned tool's platform map but never executed by trellis — no digest is recorded for it |

For jscpd 5.2.1: **linux-x64-gnu** is `tested`; **darwin-arm64** is
`research-tested`; linux-arm64 (gnu/musl), linux-x64-musl, darwin-x64, and
Windows (x64/arm64) are `declared-untested`. Hosts outside the table
resolve `unsupported` — trellis claims no universal platform support. A
`declared-untested` platform that is present resolves with
`binaryDigestVerified: false` (everything except the binary digest is still
verified); the recorded digests are the only ones claimed.

## Where upgrades change analysis identity

The pinned tool version is part of **provider identity** and therefore of
**analysis identity** (SPEC §16.2): evidence compares only across identical
provider and analysis identity (SPEC §16.6). Consequences:

- Bumping the pin (e.g. jscpd 5.2.1 → 5.2.2) is a **manifest change**: new
  version, fresh digests from the real distribution, and fresh platform
  execution records. It must never happen silently at runtime.
- Old reports remain valid; their evidence simply predates the new pin and
  compares as a different basis, never as a silent trend.
- The adapter version, mode, and option set (later steps, `trellis-f4e2`)
  join the tool version in analysis identity.

## Isolation from the native core

- The pin is a **devDependency**, never a runtime dependency:
  `scripts/smoke-package.ts` asserts the packed tarball keeps optional
  provider tools out of the native runtime (`EXCLUDED_OPTIONAL_TOOLS`).
- `knip.json` lists `jscpd` and `dependency-cruiser` under
  `ignoreDependencies` — justified because the artifacts are resolved by
  string at runtime through the manifest (the pins must stay); removing a
  pin to satisfy the dependency gate is not an option.
- Nothing in `src/audit/`, scoring, or the report schema reads this
  machinery; only explicitly requested provider evidence will (later plan
  steps).
