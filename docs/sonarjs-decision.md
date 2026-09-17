# SonarJS distribution and metric-interface decision (trellis-db3e)

Plan `pl-43c5` step 25, seed issue `trellis-db3e`, exercising the Sonar
decision gate required by [SPEC.md](../SPEC.md) §16.7 and the provider
contract in [AGENTS.md](../AGENTS.md). This is the bounded decision record
the gate names: it records the exact distribution/licensing evidence, decides
the executable-support question, fixes the metric/rule access strategy a
cleared route must follow, preserves the candidate acceptance set, and
publishes the outcome.

This record is a decision, not a legal opinion. Nobody in this repository
renders legal advice, and no communication with SonarSource, any registry,
or any counsel is performed or implied by it (issue acceptance 5).

## Published decision

**Outcome: DEFERRED — explicitly.** Executable SonarJS support is not
cleared, not claimed, and not implemented. Until a permitted route is
established by a separate, versioned change:

- The `sonarjs` provider id is *known* configuration (a request for it is
  valid, not an unknown-id operational error — SPEC §16.2/§16.3).
- A request resolves to `unsupported` with the recorded reason below —
  visible, policy-testable, never a claimed implementation and never an
  invented zero-valued metric (SPEC §16.7).
- A declarative policy requirement on Sonar evidence fails closed
  (report still emitted, exit `2` — SPEC §16.3).
- Default native audits are unaffected: offline, no-write, no-Git,
  no-credentials, no model (§1, §8, §16).

The typed carrier of this decision is the supported-provider capability
metadata in [`src/providers/capabilities.ts`](../src/providers/capabilities.ts);
the follow-through (deferred-capability behavior and tests) is owned by
`trellis-7b99`. The decision may be overturned by the operator later — but
only through a new versioned change that records the clearance evidence; it
never flips implicitly.

## Distribution and licensing evidence (exact, pinned)

Everything below is observable in the pinned research distribution checked
in under
[`docs/research/sonar-provider-spike/`](research/sonar-provider-spike/)
(lockfileVersion 3; installed with `npm ci --ignore-scripts`; nothing
vendored into trellis):

| Evidence | Value |
|---|---|
| Direct pin (provider-package.json) | `eslint 9.39.1`, `eslint-plugin-sonarjs 3.0.5`, `@typescript-eslint/parser 8.46.2` |
| Lockfile entry (`provider-package-lock.json`) | `eslint-plugin-sonarjs` 3.0.5, resolved from `registry.npmjs.org/eslint-plugin-sonarjs/-/eslint-plugin-sonarjs-3.0.5.tgz`, integrity `sha512-dI62Ff3zMezUToi161hs2i1HX1ie8Ia2hO0jtNBfdgRBicAG4ydy2WPt0rMTrAe3ZrlqhpAO3w1jcQEdneYoFA==` |
| Lockfile `license` field | `LGPL-3.0-only` |
| Installed package `package.json` `license` | `LGPL-3.0-only` |
| Shipped `LICENSE` file | identifies the **SONAR Source-Available License v1.0** |
| Cognitive-complexity implementation header | identifies the **SONAR Source-Available License v1.0** |

Relevant upstream terms, as evidenced: `LGPL-3.0-only` is a strong copyleft
license; the SONAR Source-Available License v1.0 is SonarSource's own
source-available license, not an OSI open-source license. **The two claims
conflict within the same pinned distribution**, and this record does not
interpret either license's terms. What it records is the operative fact for
the decision:

**Package metadata alone does not authorize redistribution.** Because the
metadata (`LGPL-3.0-only`) and the shipped text (Source-Available v1.0)
disagree, no distribution route can be inferred from metadata, and no route
is established by anything in this repository.

## Distribution decision: no permitted route — deferred

A permitted deployment route would be chosen only if authorization were
established (issue acceptance 2). It is not:

- The pinned distribution carries the conflicting license evidence above.
- No written determination from an authorized party (SonarSource or the
  operator's qualified counsel) exists in this repository.
- The repo's agents cannot obtain legal advice, and the spike record
  deliberately draws no legal conclusion.

**Concrete prerequisite that would clear it** (separately tracked as seeds
issue `trellis-7f5d`): a written determination by an authorized party that
resolves the `LGPL-3.0-only` versus Source-Available v1.0 conflict and
establishes a route trellis can lawfully exercise — for example, written
confirmation that the distribution is LGPL-3.0-only with obligations
trellis can satisfy, or explicit written permission for the intended use —
recorded as dated evidence in this repository. Until that closes, no
redistribution of any SonarJS artifact happens, nothing is vendored, and
broad SonarQube integration stays out of scope.

## Metric-interface decision: research adapter not adopted; strategy recorded

The research adapter is **explicitly not a stable API and is not adopted**.
It parses threshold-zero ESLint diagnostics and maps them to core functions;
parsed diagnostic wording is *not* a universal API — messages and message
ids are incidental strings of the pinned versions, not contracts
(issue acceptance 3). A future cleared route must instead follow this
recorded strategy:

- **Pinned execution**: ESLint `Linter` API over the pinned
  `eslint`/`eslint-plugin-sonarjs`/`@typescript-eslint/parser` versions,
  run as a controlled local subprocess per SPEC §16.4 (fixed argv, explicit
  environment, limits, no shell, no target scripts or configuration).
- **Controlled configuration only**: the checked-in fixed config — the four
  selected rules, the TS parser, module mode, ECMAScript 2022, JSX parsing.
  No project/tsconfig loading, no type-aware services, no target plugins,
  no inline directives, no automatic fixes — exactly the research harness's
  boundary.
- **Cognitive complexity**: `sonarjs/cognitive-complexity` at threshold 0;
  each diagnostic maps to the smallest containing core function; zero is
  inferred from absence **only** when observed coverage and rule execution
  are asserted for that file; parse failures, unmapped diagnostics and
  duplicate mappings are errors, never dropped.
- **Selected syntax-only rules** (findings kept separate from cognitive
  metrics): `no-identical-expressions`, `no-identical-conditions`,
  `no-element-overwrite`. No type-aware rules; no rule-suite expansion
  without a new versioned change.
- **Parser compatibility**: the provider resolves TypeScript 5.9.3 while
  trellis's core pins TypeScript 6.0.3; compatibility is asserted per pinned
  run and recorded in analysis identity (§16.2, §16.6) — a changed parser
  version is a different analysis, never a silent trend. Success on this
  corpus establishes no future-syntax compatibility.
- **Provenance**: every result carries provider identity (id, pinned tool
  version, adapter version, mode/options), analysis identity (input snapshot
  + provider parser version), and observed coverage asserted from the
  provider's own evidence — never from exit status. Evidence ids live under
  the reserved `provider.sonarjs.*` namespace and never enter native
  metrics or native finding kinds.

## Candidate acceptance set — preserved, and scoring weights prohibited

A cleared route must keep passing the spike's controls (issue acceptance 4).
Canonical fixture values live in
[`docs/research/sonar-provider-spike/fixtures.json`](research/sonar-provider-spike/fixtures.json);
the control names are preserved executably in
[`src/providers/capabilities.ts`](../src/providers/capabilities.ts)
(`SONARJS_METRIC_CONTROLS`, `SONARJS_BUG_RULE_CONTROLS`) with a drift test
against the fixtures, so the set cannot be silently swapped.

The six metric controls (expected cognitive / core CC arrays):

| Control | Cognitive | Core CC |
|---|---|---|
| `nested` | [6] | [4] |
| `guards` | [3] | [4] |
| `extracted` | [3, 1] | [3, 2] |
| `legitimate-dispatch` | [1] | [5] |
| `direct` | [0] | [1] |
| `forwarding-layers` | [0, 0, 0] | [1, 1, 1] |

The six bug controls — each of the three selected rules with one positive
(expected finding) and one negative (expected zero) control.

**Scoring is explicitly prohibited from changing.** SonarJS evidence is
unscored, namespaced, supplemental evidence (SPEC §16.5). The sloppiness
index keeps its native, calibrated basis; cognitive complexity and rule
findings never receive scoring weights here, and any backend promotion or
new weight requires a separately versioned calibration with its own corpus
validation — outside this decision and this plan. Silently replacing a
native metric with a Sonar-derived one is likewise prohibited.

## Record provenance

- Research inputs: [`docs/research/sonar-provider-spike/README.md`](research/sonar-provider-spike/README.md)
  (base repository revision `f3743bc0154ba032ef957a20dea678face1b3fa8`),
  [`docs/research/provider-spike.md`](research/provider-spike.md).
- Decision owner: `trellis-db3e` (plan `pl-43c5`, step 25). Follow-through:
  `trellis-7b99`. Clearance prerequisite: `trellis-7f5d`.
- No external communication, legal representation, redistribution, or
  SonarQube integration is performed by this record.
