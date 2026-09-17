# Architecture

[Back to the README](../README.md)

```
src/
├─ cli/            # THIN commander entrypoints; delegate to core (SPEC §13.1)
├─ client/         # typed SDK over the core; mirrors core types
├─ audit/          # deterministic core: discover → parse → measure → score → assemble
├─ config/         # declarative audit configuration (trellis.yaml)
├─ contract/       # versioned zod contracts: metrics, findings, report, config
├─ discovery/      # TS/TSX source discovery → classified workspace inventory
├─ syntax/         # shared parse layer (pinned TS compiler API) + function inventory
├─ metrics/        # complexity, erosion, duplication, import graph/cycles
├─ safeguards/     # hook/check configuration inspection (non-scoring)
├─ scoring/        # provisional sloppiness formula (pure)
├─ report/         # terminal / JSON / markdown renderers
├─ compare/        # artifact comparison + declarative failure policies
├─ store/          # OPTIONAL SQLite history (append-only; legacy runs separate)
├─ history/        # history dashboard projection
├─ fleet/          # OPTIONAL targets.yaml orchestration over the same core
└─ standards/      # canonical-config drift (separate capability)
```

All behavior lives in the core; `src/cli/` and `src/client/` are thin
pass-throughs (**api>cli>sdk**, SPEC §13.1). See
[`docs/architecture.mmd`](architecture.mmd) for the module graph and
[`docs/corpus-validation.md`](corpus-validation.md) for the fixed-corpus
score-behavior and performance record.
