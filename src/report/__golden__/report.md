# Agentic-readiness scorecard — `sample-repo`

**Level 2 / 5** · pass-rate **50%** · coverage **75%**

- Rubric `0.2.0` · commit `abc1234def5678` · scored 2026-06-06T00:00:00.000Z
- Apps (2): `.`, `src/ui`
- Measured 2/4 criteria · 1 no-detector · 1 not-applicable

| Category | Measured | No-det | N/A | Pass-rate |
| --- | ---: | ---: | ---: | ---: |
| Documentation | 1/2 | 1 | 0 | 100% |
| Code Quality | 1/2 | 0 | 1 | 67% |

## Gate criteria failing

Category-floor criteria that were measured and did not fully pass:

- `lint_config` — 2/3 apps pass \| piped

## Criteria

### Documentation

| Criterion | Verdict | Score | Rationale |
| --- | --- | ---: | --- |
| `adr_presence` | no-detector | n/a | no detector bound for this criterion |
| `readme` | pass | 1/1 | README.md present |

### Code Quality

| Criterion | Verdict | Score | Rationale |
| --- | --- | ---: | --- |
| `lint_config` | partial (gate) | 2/3 | 2/3 apps pass \| piped |
| `type_check` | not-applicable | n/a | no tsconfig in any app |

## Canonical-config drift — `1.0.0`

- match 1 · allowed-delta 0 · drift 1 · missing 0 · extra 0

| File | State | Version | Matcher | Divergences |
| --- | --- | --- | --- | ---: |
| `biome.json` | drift | 1.0.0 | json-subset | 1 |
| `tsconfig.json` | match | 1.0.0 | json-subset | 0 |

### `biome.json` divergences (drift)

- `linter.rules.style` (changed): values differ

## Changes since last run

- Previous: Level 1 · commit `0000000prev` · rubric `0.2.0` · scored 2026-06-05T00:00:00.000Z
- Net level move: +1 (attribution: code)

| Criterion | Move | Before | After |
| --- | --- | --- | --- |
| `readme` | fail-to-pass | fail 0/1 | pass 1/1 |
