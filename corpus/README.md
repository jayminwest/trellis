# corpus/ — the fixed TypeScript validation corpus

The fixed corpus of SPEC §14 stage 10 (trellis-e924): a small, reproducible
set of representative TypeScript workspaces that validates the deterministic
audit's score behavior and performance. The measured record — environment,
revisions, sizes, runtime/memory observations, budgets, paired-refactor
results, and the calibration decision — lives in
[`docs/corpus-validation.md`](../docs/corpus-validation.md).

## Layout

- `manifest.json` — the corpus definition: entries, per-entry runtime and
  peak-memory budgets, single-entry review checks, and the paired-refactor
  expectations. Validated by zod in `scripts/validate-corpus.ts`.
- `fixtures/<id>/` — committed mini-workspaces (a `package.json` plus
  `src/`). Each pair's `before`/`after` fixtures are identical except for
  the one controlled change:
  - `clone-base` / `clone-removed` — a cross-file type-2 clone pair,
    deduplicated in `after` (clone removal).
  - `branch-base` / `branch-grown` — one function's branches grown past the
    erosion threshold (CC 3 → 14), everything else identical (branch
    growth).
  - `acyclic` / `cyclic` — a four-module layer; `after` flips one import to
    close a cycle (cycle introduction).
  - `dilution-base` / `dilution-grown` — a sloppy core (one hotspot, one
    clone pair); `after` adds a large clean module (score-dilution review).
  - `clean-small` — a tiny clean repo (small-repo behavior).
  - `test-separation` — clean production, heavily cloned and eroded tests
    (test separation).
  - `incomplete-parse` — one file with a syntax error (incomplete-analysis
    handling).
- `trellis-self` — the enclosing trellis checkout at the recorded revision
  (the real-repo anchor; `corpus/` itself is excluded from discovery by the
  repo's `trellis.yaml`).

Fixture clone bodies are deliberately **structurally heterogeneous**: after
identifier/literal normalization, any templated repetition (repeated branch
blocks, generated function families) is itself a clone and would pollute
the controlled change. Corpus fixtures are audit *inputs* — they are
excluded from the repo's own lint, typecheck, duplication, and coverage
gates on purpose.

## Running the validation

```bash
bun run scripts/validate-corpus.ts                 # full run: 3 child-process runs per entry
bun run scripts/validate-corpus.ts --out record.json
bun run scripts/validate-corpus.ts --in-process --runs 1 --no-self   # fast pass
```

The harness audits every entry through the same `auditWorkspace` core the
CLI and SDK fold — no model, no network, no project commands — measures
wall time and peak RSS (fresh child process per run; VmHWM), checks each
entry against its manifest budget, and asserts the paired expectations and
review checks. Exit 0 means the corpus validates; the markdown record is
printed either way. `scripts/validate-corpus.test.ts` exercises the harness
against this corpus in-process, so the paired expectations are also
continuously tested.

## Changing the corpus

Fixture changes are measurement-semantics changes: keep pairs identical
except for their controlled change, re-run the validation, and update
`docs/corpus-validation.md` and any calibrated constants in the same
commit. External corpus acquisition (cloning outside repositories) is a
separate preparation step and never part of an audit (SPEC §14).
