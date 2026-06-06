# Investigation golden fixtures (SPEC §9.7)

One frozen `pi --mode rpc` session per investigation area, plus a corrupted
fixture. Each `<area>.jsonl` is the **full JSONL event stream** a bounded Pi run
emits — `agent_start`, reasoning/tool-call `message_end` envelopes, the
`submit_findings` `toolCall`, and the terminal `agent_end` — with every volatile
field **canonicalized** to a fixed placeholder (see `../golden.ts`):

| Volatile field | Placeholder |
| --- | --- |
| session / message / tool-call / response ids | `00000000-0000-0000-0000-000000000000` |
| timestamps | `1970-01-01T00:00:00.000Z` |
| `usage` | `{ "inputTokens": 0, "outputTokens": 0 }` |
| `cost` / `*Ms` accounting | `0` |

Canonicalization is **idempotent**, so `golden.test.ts` asserts each frozen file
already equals `canonicalizePiStream(file)` — a re-record produces a clean diff,
never noise.

## ⚠️ These fixtures are hand-authored

No live `pi` capture exists yet. Per the §9.7 bootstrap note, these streams are
**hand-authored to the documented v0.74.0 wire shape** (the envelope shape
`session.ts` reads and `fake-pi.ts` builds), not recorded from a real model run.
They are faithful to the protocol but were not produced by Pi. Replace them with
real captures via the regeneration gate below; the offline harness asserts the
exact grades each stream produces either way.

## Fixtures

- `documentation.jsonl` — a well-documented repo; every documentation criterion **passes**.
- `agent-config.jsonl` — a strong agent surface; every agent-config criterion **passes**.
- `setup-runnability.jsonl` — env-file secrets, no local services, no devcontainer; secrets **pass** + two **not-applicable** grades.
- `test-layout.jsonl` — unit tests but no integration tests and no flaky handling; a **pass/fail** mix.
- `corrupted.jsonl` — `submit_findings` smuggles a verdict-shaped `passed` key the strictObject schema rejects; replayed, it drives the corrective-prompt → **`no-detector`** path.

## Regenerating from a live Pi (operator only)

Capture is gated so **CI never makes a model call**:

```bash
TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live [--area <id>]
```

Both `TRELLIS_UPDATE_PI_GOLDEN=1` **and** `--live` are required; the script
refuses otherwise. It spawns a real `pi --mode rpc` per area, captures stdout,
canonicalizes, and overwrites the frozen file. See `RUNBOOK.md` → "Regenerating
investigation goldens".
