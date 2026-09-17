# Migrating from the readiness product

[Back to the README](../README.md)

The pre-`0.2` **agent-readiness** product (90-criterion rubric, maturity
levels, LLM investigation layer) is **retired**, not reinterpreted
(SPEC §14):

- **Scores don't carry over.** Readiness percentages/levels and the
  sloppiness index are different quantities. Existing history databases keep
  their legacy runs, visibly labeled, and never trend them against the new
  index. There is nothing to convert — start a fresh baseline with
  `trellis audit . --json --out baseline.json`.
- **Retired flags fail fast.** `--rubric-version`, `--min-level`,
  `--fail-on gate|level`, `--no-cache`, provider/model knobs, and the
  investigation env vars exit `1` with an actionable "removed in the
  deterministic pivot" message instead of silently changing meaning. The
  new failure policy is the declarative `policy` block in [the CLI reference](cli-reference.md).
- **`targets.yaml` keys retired.** Per-target `skip` and `languages` and
  `defaults.investigation` are rejected with migration errors; keep
  `id`/`path`/`config`/`canonical`.
- **`rubric` is retired.** The CLI returns migration guidance; the SDK no
  longer exports `rubric`, `loadRubric`, or readiness assessment helpers.
  Use `audit` and `assessPolicy` for the new report and policy contract.
  **`drift` / `standards` remain separate, unscored capabilities.** Legacy
  internals support historical compatibility and fixtures, not public audits.
