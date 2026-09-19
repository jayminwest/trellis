# Release acceptance

The release contract is a deterministic, offline TypeScript/TSX audit. Native
metrics determine the 0–100 sloppiness index; lower is better. Safeguards,
canonical drift and opt-in provider evidence are reported separately.

| Contract | Executable evidence |
| --- | --- |
| Stateless native audit and explicit history | `src/audit/run.test.ts`, `src/cli/audit.test.ts` |
| CLI and SDK use the same measurement and policy | `src/client/index.test.ts` |
| Fleet preserves per-target policy and failures | `src/fleet/orchestrate.test.ts`, `src/cli/fleet.test.ts` |
| Existing audit artifacts remain readable | `src/store/audit-history-storage.test.ts`, `src/contract/report-versions.test.ts` |
| Compatible index history | `src/history/dashboard.test.ts`, `src/store/audit-store.test.ts` |
| Package contains runnable CLI and analyzer assets | `scripts/smoke-package.ts` |

Run `bun run check:all` for the local quality gates and `bun run smoke:package`
for packed-install validation. These commands validate the current checkout;
this document does not assert execution on untested platforms.

See [corpus validation](corpus-validation.md) for fixed-corpus score and
resource evidence, [provider acceptance](provider-acceptance.md) for executed
provider platforms, and [scoped identity and duplication acceptance](scoped-identity-duplication-acceptance.md)
for baseline, policy and history regressions.

The formula remains provisional. Optional providers are advisory and require
operator-prepared tools; SonarJS is deferred. Audits inspect safeguard
configuration and never execute a target's checks.
