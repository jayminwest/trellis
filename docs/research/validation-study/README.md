# Independent validation study kit (trellis-f999, trellis-ba11)

Protocol `validation-study-v1`, prepared 2026-09-25. **Status: awaiting
independent judgments.** No conclusion is drawn and nothing here feeds the
audit, the score, budgets or any public surface.

Both issues ask the same question of different signals: on held-out
TypeScript maintenance tasks, judged by people who did not write the tasks,
do the candidate structural signals (forwarding/dispatch counts from the
[slop spike](../slop-spike.md); flow and clone context from the
[maintainability spike](../maintainability-spike.md)) agree with maintainers
more often than LOC, CC and native duplication, and where do they mislead?

## Contents

- `tasks.json` — 12 paired `before`/`after` versions of the same behavior,
  each with the maintenance change a reviewer should imagine making.
  Categories cover every case the two issues name: legitimate facade,
  callback adapter, transaction wrapper, unrelated dispatch domains,
  default/subset options, if-chain ↔ lookup table (two variants), loop
  guard, single-use extraction, independent rules, declarations with
  callbacks, overlapping clone ranges.
- `judgments.json` — reviewer judgments; committed empty.
- `src/research/validation-study.ts` — measures LOC, total/max CC, total/max
  flow, function count, forwarders, switch dispatches and native clone groups
  on both sides; builds the blinded packet; analyzes judgments.
- `scripts/validation-study.ts packet|analyze` — runner.

## Reviewer procedure

1. Generate the packet: `bun run scripts/validation-study.ts packet`. Each
   task shows versions **A** and **B** in a deterministic hash-based order;
   which side is `after` and every signal value are withheld.
2. A reviewer must not have written or edited `tasks.json`, and must not look
   at signal output before submitting.
3. For each task, the reviewer imagines making the stated change and records
   which version is easier to change **safely** (`"A"`, `"B"` or `"same"`):

   ```json
   { "taskId": "loop-guard", "reviewer": "<stable pseudonym>", "preferred": "A", "independent": true }
   ```

4. Append to `judgments.json` and run
   `bun run scripts/validation-study.ts analyze`.

## Analysis rules

- A task is decided only with at least two distinct independent reviewers
  and a strict majority; ties and `same` majorities are undecided.
- Per signal, over decided tasks: **agrees** when the signal decreases for a
  preferred `after` or increases for a preferred `before`; **false
  positive** when it decreases but reviewers preferred `before`; **miss** when
  reviewers preferred `after` and it did not decrease.
- Report false positives and misses by task id before proposing any scoring
  change. Any proposal still needs explicit versioning and corpus
  calibration (SPEC §7, §14).

## What an agent cannot supply

The judgments. Agent- or model-produced preferences are not independent
review and must not be recorded as `independent: true`; the kit's
`independent` flag exists so they can be kept out of the analysis if they are
ever collected for comparison.
