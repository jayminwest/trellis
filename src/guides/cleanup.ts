/** Canonical cleanup workflow, bundled with Trellis; shared by CLI, SDK and docs. */
export const CLEANUP_GUIDE = `# Trellis cleanup guide

Run Trellis and iteratively reduce structural debt while preserving behavior and
repository boundaries. Make small, coherent changes, run the relevant checks,
and compare before and after. Prefer changes that remove duplication, clarify
responsibilities, or simplify dependencies. Do not add indirection merely to
improve metrics. Stop when remaining findings have no clearly justified
improvement, and explain what remains.

This is task-specific guidance for an external agent or human. Reading it writes
nothing and starts no audit, target command, cleanup process, or agent. Trellis
does not call models. You own edits and verification; project checks run outside
Trellis. The guide needs no target repository, Git, credentials, network, or
installed target dependencies. Audits need source files; project checks may need
their own tools and dependencies. Follow repository instructions for those.

## 1. Read constraints and establish the starting state

Read the target repository's agent instructions, architecture boundaries, and
required checks. Respect existing work and the user's scope. Inspect relevant
configuration, source exclusions, and known failures before editing. Do not
assume permission to publish, push, change public behavior, or cross boundaries.

From the target root, save a baseline outside the source tree. Choose a fresh
artifact directory you control; replace /path/to/artifacts below with that
existing directory, and do not overwrite earlier evidence:

    trellis audit . --json --out /path/to/artifacts/before.json

The explicit --out requests a file write. Default native audits need no Git,
credentials, network, or installed target dependencies. Keep optional providers
off unless the task calls for them and their pinned local tools are prepared.
Preserve the original baseline across the entire cleanup session.

## 2. Choose one bounded improvement

Read completeness, raw metrics, score contributions, hotspots, findings, and
separate safeguard evidence. Use JSON for details omitted from terminal summaries.
Treat rankings as leads, not a mandate: inspect the located source, related code,
callers, and tests. Consider production and test code in their own roles.
Incomplete or unsupported analysis is missing evidence, not proof of cleanliness.

Choose a small scope with a concrete design benefit: repeated logic with the same
reason to change, a tangled responsibility, or a dependency cycle whose direction
can be simplified. State the behavior to preserve, why the change helps, and how
you will verify it. If evidence is ambiguous, inspect further or leave it alone.

## 3. Make a coherent change and verify behavior

Preserve public contracts and repository boundaries. Avoid metric-only helper
extraction, awkward deduplication of merely similar code, generic abstractions
with flags for unrelated cases, or moving complexity into harder-to-follow helpers.
Do not game the score by excluding, suppressing, or reclassifying analyzed code,
weakening checks, or changing scoring configuration to hide debt.

Run the repository's relevant tests and required checks yourself, outside Trellis.
Trellis never runs them for you; safeguard detection is not evidence that checks
passed. Inspect the diff for behavior changes and unnecessary indirection. Record
which checks ran and their results; disclose pre-existing or blocked failures.
Revise or revert your own change if its benefit or behavior preservation is unclear.

## 4. Compare structure and design

With the same Trellis version, configuration, and intended source scope, capture
the result and compare saved artifacts:

    trellis audit . --json --out /path/to/artifacts/after.json
    trellis compare /path/to/artifacts/before.json /path/to/artifacts/after.json

Exit 0 means the command completed without a policy failure, not that the design
is good. Exit 2 means policy failure or an incompatible comparison; read the
emitted report and stderr. Exit 1 means an operational error; resolve it before
using the result as evidence. Respect compatibility warnings and scope caveats.
Provider evidence has its own compatibility and never changes the native score.

A lower 0–100 sloppiness index is a measurement, not proof of design improvement
or a percentage of bad code. Check whether the change reduces duplication of
responsibility or makes behavior easier to follow. For clone groups with line
overlap, review the repeated structure before treating matches as separate
implementations to consolidate; shared lines do not prove token overlap.
Review raw metrics and changed findings alongside
the diff, tests, responsibilities, dependency direction, and readability. Inspect
moved code and extracted helpers even if they fall below hotspot thresholds.
New/resolved finding pairs can reflect ambiguous matching rather than real debt
removal. An unchanged score can accompany a useful change; a lower score can
accompany a worse design. Explain any regression rather than trading away clarity.

## 5. Repeat deliberately, then stop

For each next candidate, keep uniquely named before/after artifacts so you can
compare that change as well as the full session against the original baseline.
Re-read current evidence after each accepted change. Continue only while a
clearly justified improvement remains within scope and can be verified.

Do not chase zero. Stop with accepted tradeoffs when further changes would obscure
intent, violate boundaries, risk behavior without adequate checks, or cost more
than their demonstrated benefit. Record residual findings with locations, reasons
for keeping them, and conditions that would justify reconsideration. If required
verification is blocked, report that limitation rather than claiming completion.

Report the changes and design benefits, before/after metrics and completeness,
artifact paths, checks and outcomes, and justified residual findings. These are
session notes, not evidence that Trellis persisted a finding disposition.

Use trellis --help to discover the commands available in your installed version.
`;
