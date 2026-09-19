# Maintainability feasibility spike

Issue: `trellis-fcff`. Protocol: `maintainability-v1`. Executed 2026-09-19.

**Result:** advance control-flow and clone-context evidence to further
validation; reject either as an immediate scoring replacement. Eight paired
examples expose both useful distinctions and cosmetic improvements. No audit,
CLI/SDK contract, provider integration, scoring constants, or budgets changed.

This is an implementation and falsification experiment, not a human or agent
comprehension study. Its target is helping a maintainer locate, understand,
and safely change behavior with less unnecessary effort.

## Prior work and scope

- [Parnas, 1972](https://www.cs.lafayette.edu/~gexia/cs301/resources/parnas.html):
  module boundaries should hide design decisions; smaller routines alone do
  not establish better modularity.
- [Cognitive Complexity validation, 2020](https://arxiv.org/abs/2007.12520):
  correlations with comprehension time and perceived difficulty, mixed
  evidence for correctness. This spike is an independently specified small
  probe, **not an implementation of Sonar Cognitive Complexity**. It neither
  executes SonarJS nor changes the deferred SonarJS decision.
- [Maintenance metrics study, 2022](https://research.tudelft.nl/en/publications/revisiting-the-debate-are-code-metrics-useful-for-measuring-maint/):
  metric usefulness depends on context and the maintenance outcome measured.
- [Earlier trellis spike](slop-spike.md): forwarding counts also match useful
  facades and callbacks, so they cannot stand alone as a waste penalty.

## Operational definitions

The research service reuses production-source discovery and the shared syntax
inventory. Functions in malformed files are omitted and named, with parse
diagnostics retained. Tests are not scored or mixed into the production
sample. Default audit exclusions apply. No target dependencies are required,
and no target commands, providers, Git operations or models run in the service.

### Flow probe

Per function, sum `1 + enclosing structural depth` for each `if`, loop,
`switch`, `catch`, and ternary expression. An `else if` chain shares one
structural level. Each binary `&&` or `||` adds one, without a nesting
multiplier. Optional chaining, nullish fallback, logical assignment, plain
`else`, `try`/`finally`, case labels, returns, throws, and recursion add no
separate points. Nested functions own their own bodies and start at depth zero.

Report the structural, nesting, and boolean components separately, plus native
CC, native nesting, and syntactic call-expression count. Calls are **context,
not penalties**: they are not resolved edges, distinct callees, or a measure
of how much context a reader actually needs. No severity cutoff, scale to
0–100, or replacement weight is proposed. Both CC and flow rankings use raw
function values; these are not the native audit's mass-weighted hotspot order.

### Clone context

Use unchanged native normalized-token detection: minimum 100 tokens and
three lines; existing work and token limits. For each surviving production
group report:

- whether any members in that group overlap on the same file's **line** ranges;
- calls, literals, and control-flow node starts located in each member range;
- `registration-candidate` when a range contains a property call named
  `option`, `addOption`, or `hideHelp`, with no detected if/loop/switch/ternary
  start; otherwise `control-flow` when such a decision starts in range;
  otherwise `other-or-mixed`. Missing/malformed files are `unavailable`.

Property calls are anchored at the method name, avoiding the beginning of an
entire chained expression. This intentionally narrow CLI-registration probe
does not classify all declarative code. Names are not symbol-resolved; methods
with these names can do arbitrary work. Callbacks can contain behavior, and
control flow enclosing a range may begin outside it. Line overhang is not
token overlap. A registration label is a **review cue**, not permission to
ignore the group. No finding is suppressed and no score is recomputed.

The reported clone counts become `null` when the native pass is incomplete;
its metric states and exhaustion reason remain visible. Parsing and
duplication completeness are separate. Complete parsing never implies a
complete clone search.

## Repository experiment

All runs used the repository's TypeScript 6.0.3 and native analyzer code from
the starting revision, with Bun 1.3.14-canary.1 on macOS arm64. Production
source-content/path SHA-256 fingerprints, source configuration, exclusions,
diagnostics, top-20 CC/flow rankings and all observed clone contexts are
preserved in the linked artifacts.

| Scope | Production files / functions | CC > 10 | Of those, native nesting ≤ 1 | Clone groups | Groups with line overlap | Registration candidates |
| --- | --- | --- | --- | --- | --- | --- |
| [trellis](maintainability-trellis.json) | 244 / 1,968 | 44 | 23 | 36 | 10 | 1 |
| [burrow](maintainability-burrow.json) | 126 / 1,171 | 55 | 14 | 24 | 2 | 0 |
| [warren](maintainability-warren.json) | 907 / 7,496 | 269 | 140 | unavailable | unavailable | unavailable |
| [warren CLI sample](maintainability-warren-cli.json) | 34 / 239 | 8 | 4 | 10 | 3 | 1 |

Trellis is a frozen archive of `b242a8694d61c2b305ae2d560dfc68a638ff22b7`,
excluding this new research code. Concurrent legacy-removal edits in the
shared workspace are therefore outside the experiment. Burrow was at
`c19c475fb915ab28f790d9f80485d98197dd0a7a` (tracker-only working changes),
warren at `16a0a77397db1a515d15704006d207d383d06dad` (a test-file working
change, outside measured production scope). These are related ecosystem
repositories, not independent representative samples of the wider industry.

Warren's full production clone search exhausted the 100,000,000 work-unit
limit in phase `index`. We did not raise the limit. The separate CLI sample
copies only `src/cli` into an isolated root, preserving relative paths, with
default configuration. It measures within-sample duplication only; it cannot
detect clones between CLI code and other modules and must not substitute for
the full-repository result.

### Concrete disagreements

| Trellis function | Native CC | Experimental flow |
| --- | --- | --- |
| `runJscpdMode` | 13 | 13 |
| `runControlledProcess` | 13 | 8 |
| `assessProviderEvidenceBudget` | 16 | 10 |
| `extractBacktickedPaths` | 14 | 23 |
| debt-marker `scan` | 19 | 22 |

The flow probe distinguishes optional access and shallow validation from
nested iteration. However, inspecting `extractBacktickedPaths` reveals many
straightforward continue guards inside a loop: it becomes the highest flow
result in trellis. The nesting multiplier may overstate its difficulty.
This is evidence to investigate, not proof the new ranking is better.

Burrow's `dispatchRun` is high under both measures (CC 52, flow 56), as is
warren's `reapRun` (104, 106). Warren's `runWithReconnect` has CC 32 but flow
68, showing that the experiment can change relative priority substantially.
No reviewer precision estimate follows from these examples.

Trellis's registration candidate is the overlapping retired-option chain in
`src/cli/audit.ts`, group 3. Warren's CLI group 10 overlaps command-registration
blocks in `src/cli/main.ts`; each member also contains many other calls.
Thus even this recognizer should retain the surrounding evidence instead of
declaring the match harmless. Zero registration candidates in burrow means
this narrow recognizer matched none, not that all its clones are actionable.

## Eight paired controls

[Source pairs](maintainability-pairs.json) and
[generated measurements](maintainability-pair-results.json) are committed.
Tests execute only these trusted JavaScript fixtures, checking equal results
for integer inputs −20 through 40. This is bounded behavioral checking,
not proof of equivalence for every possible JavaScript input.

| Transformation | Max CC before → after | Total flow before → after | Interpretation |
| --- | --- | --- | --- |
| Nested conditions → guard clauses | 3 → 3 | 3 → 2 | Useful distinction CC misses |
| Nested else blocks → else-if chain | 4 → 4 | 6 → 3 | Recognizes flattened alternatives |
| Extract an inner helper | 3 → 2 | 3 → 2 | Both improve while call/context requirements increase |
| Add forwarding layers | 1 → 1 | 0 → 0 | Both miss added machinery; calls rise 0 → 2 |
| Switch → lookup table | 4 → 2 | 1 → 0 | Representation sensitivity remains |
| Boolean conjunction → guards | 4 → 4 | 3 → 3 | Neutral result despite changed presentation |
| Consolidate one shared rule | 2 → 2 | 2 → 1 | Detects reduced repeated branching |
| Parameterize two independent rules | 2 → 2 | 2 → 1 | Same reward despite a questionable abstraction |

All pairs have zero eroded functions under today's CC > 10 rule. They are
small controls, not evidence for a numerical score reduction on real projects.
The last two pairs deliberately give matching metric responses: source
structure alone does not tell this probe whether the rules should evolve
together. The intended responsibilities are author-supplied scenarios, not
independently verified labels. These examples were authored alongside the
probe and are not a held-out benchmark.

## Decisions

1. **Investigate flow evidence further; do not replace CC scoring.** Keep
   flat guards inside loops, optional access, switches, and helper extraction
   as explicit controls. Compare against established cognitive-complexity
   definitions before adding further ad hoc rules.
2. **Advance overlap/context presentation, not automatic clone suppression.**
   Broader declarative detection needs independently reviewed samples of
   schemas, tables, registrations and behavior embedded in those structures.
3. **Reject total call count and raw flow as standalone quality scores.**
   Neither resolves the shared-rule versus forced-generalization ambiguity.
4. **Keep production scoring unchanged.** Next, use held-out maintenance
   tasks and independent human judgments to establish whether the evidence
   helps locate defects or implement changes. Evaluate agents separately;
   no model grades should feed audit reports or runtime scoring.

The independent-validation follow-up is tracked as `trellis-ba11`.

## Reproduce

From this checkout with its development dependencies already installed:

```sh
bun test src/research/maintainability-spike.test.ts
bun scripts/spike-maintainability.ts --pairs > docs/research/maintainability-pair-results.json
bun scripts/spike-maintainability.ts /path/to/workspace --summary > /tmp/evidence.json
```

Omit `--summary` for every measured function. Saved summaries preserve all
clone groups but only the top 20 functions in each raw ranking. Ties retain
path/function source order. No output is written unless redirected.

To regenerate the trellis artifact from the recorded revision:

```sh
snapshot=$(mktemp -d /tmp/trellis-maintainability.XXXXXX)
git archive b242a8694d61c2b305ae2d560dfc68a638ff22b7 | tar -x -C "$snapshot"
bun scripts/spike-maintainability.ts "$snapshot" --summary > docs/research/maintainability-trellis.json
```

Use checkouts of the recorded burrow/warren revisions for their artifacts.
For the CLI-only sample, copy warren's `src/cli` to a fresh temporary root's
`src/cli`, then run the same command on that root. This is deliberate sample
selection, not a change to warren's audit configuration.

The research command is repository-only and has no public SDK/CLI export.
No new dependency, corpus exclusion, scoring version or budget relaxation is
needed. The focused suite covers paired behavior, nested ownership, parse
gaps, ordering, source sets, clone context, configured real-filesystem reads,
and native score stability before/after research execution.

## Verification record

The 15 focused tests pass (521 assertions). The trellis summary and paired
results regenerate byte-for-byte from an isolated checkout containing the
starting revision plus this spike. That checkout also passes standalone lint,
typecheck, all 2,227 tests, and all nine `check:all` gates (58.9 seconds).
No coverage, duplication or size budget was relaxed. The temporary checkout retains the starting
revision's Git metadata because an existing corpus-environment test requires
it; the research command itself never uses Git.

Shared-workspace checks encountered unrelated failures during concurrent
legacy-removal edits. Their results are not attributed to this spike, and
this spike does not modify those files. Isolation validates the research
change against its recorded base, not the unfinished concurrent changes.
