# Provider acceptance record

Plan `pl-43c5`, steps `trellis-1e03` and `trellis-b18d`.
This record covers jscpd, dependency-cruiser and deferred SonarJS.
Knip integration acceptance remains pending `trellis-8ebc`; this is not
a claim that the entire milestone has passed.

## Executed environment

On 2026-09-17: macOS 26.5.2 (25F84), ARM64, Bun
1.3.14-canary.1+11a2e2c20, TypeScript 6.0.3, jscpd 5.2.1,
dependency-cruiser 18.3.1 (adapter 0.1.0). The dependency-cruiser
launcher SHA-256 is
`3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6`;
its package manifest is
`6aed892071cdd9ebca9517665d19a67ded18510f64a608beb611f711623c6cbd`.
Both matched the existing Linux distribution pins before execution.

The architecture corpus passed before adding the macOS host declaration:
12 selected files were represented, with distinct runtime/type-only cycles,
an allowed boundary exemption and an unresolved local import. The complete
dependency-cruiser and cross-provider suites then passed: 85 tests,
239 assertions. Package and provider-tool smoke checks also passed on this
host. Linux x64 has the earlier step-22 record; it was not re-executed here.
The local Colima VM could not start (its disk was reported in use).
Other OS/architecture combinations retain their manifest status; no
Windows, Intel macOS or Linux ARM64 execution is claimed by this record.

## Offline and resource run

Preparation (`bun install --frozen-lockfile`) happened separately. The
acceptance command ran with network operations denied by the OS and writes
denied to both measured checkouts:

```bash
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/private/tmp/trellis-pl-43c5") (subpath "/Users/jayminwest/Projects/os-eco/seeds"))' bun scripts/provider-acceptance.ts /Users/jayminwest/Projects/os-eco/seeds
```

Use the actual absolute checkout paths when reproducing. The harness clears
`PATH` and inherited credentials, hashes all inventoried source bytes before
and after each run, and checks its isolated temporary directory for leaked
scratch. Its no-Git control has no target dependencies, failing target
scripts and executable configuration sentinels. Every target's native score
must equal its provider-enabled score. No reports or databases are written
to the target. Bun's transpiler cache is disabled for this measurement with
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`: Bun otherwise creates its own cache
outside trellis's control, including on native audits.

| Target | Native ms | Providers ms | Native peak RSS bytes | Providers peak RSS bytes |
| --- | ---: | ---: | ---: | ---: |
| Small control with executable-config sentinels | 261 | 767 | 265109504 | 272056320 |
| 40 identical 13-line source copies | 280 | 782 | 282492928 | 292143104 |
| Trellis checkout | 925 | 2350 | 656719872 | 759562240 |
| Prepared Seeds checkout | 605 | 1518 | 516882432 | 543703040 |

The [raw measurement artifact](provider-acceptance-macos.json) retains source
hashes, parser identities and the exact incomplete-evidence reasons.
These are observations, not throughput guarantees. Duration includes report
validation and post-run hashing. RSS is Bun's direct child-process
`resourceUsage().maxRSS`, not a sum of concurrent process memory or a hard
memory limit. The harness prints input hashes, tool parser identity, states
and reasons so a rerun can distinguish changed inputs from changed engines.

The stress control produced complete jscpd and architecture evidence.
Short sentinel files made control jscpd incomplete. Trellis's architecture
and jscpd evidence were incomplete; Seeds architecture was complete and
jscpd incomplete. These gaps remained visible while native scores stayed
identical. SonarJS remained unsupported everywhere. No partial result was
counted as a complete zero.

## Maintained verification map

| Requirement | Executable evidence |
| --- | --- |
| Shared corpus, repeats, native isolation, mixed states, independent comparison | `src/audit/cross-provider.test.ts` |
| Combined CLI/SDK/fleet parity, real SQLite history and saved artifacts | `src/client/cross-provider-surfaces.test.ts` |
| Idiomatic, renamed, near, unrelated clones; exact pairs versus groups; source-set boundaries | `src/providers/jscpd/conformance*.test.ts` |
| Changed architecture policy; type/runtime separation; stubs and missing parser | `src/providers/dependency-cruiser/*.test.ts` |
| Missing/version-mismatched binaries and unsupported hosts | `src/providers/resolve.test.ts` |
| Timeout, output budget, process termination | `src/providers/process.test.ts` and provider failure suites |
| Cancellation, interrupted work, cleanup failure visibility | `src/providers/staged-run.test.ts` and `workspace.test.ts` |
| Native no process/model/network boundary calls, no target writes | `src/audit/offline.test.ts` |
| Runtime-only packed installation and pinned asset/version checks | `bun run smoke:package`, `bun run smoke:provider-tools` |

The full local suite passed 2,025 tests and all nine quality gates. The
quality-evidence guide's commands were also executed against a controlled
clone-pair fixture: CLI/SDK/fleet, JSON/Markdown output, saved comparison,
SQLite history and operational/policy exits 0/1/2 passed.

Run `bun test`, `bun run lint`, `bun run typecheck`, and
`bun run check:all` as well as the explicit smoke/acceptance commands.
Real-tool tests skip on unavailable hosts; a skip is never acceptance.
Expected fixture observations are authored assertions next to each suite.
To update, inspect raw evidence and identity changes, edit the explicit
assertions, and rerun the named suite; there is no automatic golden rewrite.

The current dependency-cruiser limits are 60 seconds and 4,000,000 bytes
per output stream. Exhaustion is unavailable/incomplete evidence, not a
deterministic quality result. These controls do not provide a universal
untrusted-code sandbox or claim an enforced memory ceiling. Outcome
validation and scoring calibration remain separate (`trellis-f999`).

## Final milestone audit (trellis-639c)

The native baseline is `eac0f57fc038d7ffb22ea04ec53d95e8b465c4b0`,
the parent of the first provider-contract commit `538996d`. It includes
`ac263e7` (asset resolution) and `1de0c90` (count-gradient calibration).
The earlier pivot-release commit `1bcb8e8` predates those foundation fixes
and must not be used to attribute their changes to optional providers.

Verified against local HEAD `9e7fd56` on 2026-09-17:

- `git diff --exit-code eac0f57 HEAD -- src/metrics src/scoring src/syntax`
  exits 0: all native measurement, scoring and parsing implementations and
  their tests are unchanged from the completed foundation.
- Coverage floors, file-size ceilings, debt allowlist and duplication
  threshold are unchanged across the same range. All nine current gates
  passed in the canonical checkout, as well as the isolated worktree.
- Foundation feature `trellis-253e` closed at 15:00:01 UTC; its final
  scoped follow-ups `trellis-831b` and `trellis-f6b0` closed at 15:16:29.
  The first provider contract child closed at 15:20:05, and its commit
  follows both implementation fixes. No foundation stage was reopened.
- The only provider subprocess creation site is `src/providers/process.ts`:
  fixed executable/argv, explicit environment, no shell, owned process
  group. Provider modules contain no network-fetch or installer call.
  The maintained offline and conformance tests exercise that boundary;
  the source scan alone is not treated as behavioral proof.
- Sonar's capability remains deferred, has no pinned artifact, and the
  tests in `src/providers/sonar/deferred.test.ts` verify the preserved
  native result, no staging, no execution and fail-closed required policy.
  Its clearance prerequisite remains `trellis-7f5d`; outcome validation
  remains `trellis-f999`.

**Still unproven:** Knip delivery and its integration acceptance. Both the
tracker and `src/providers/capabilities.ts` still say adapter-pending;
`src/audit/providers.ts` routes it through undelivered evidence. No Knip PR
was open or among the recent merged PRs at this audit. The user assigned
that implementation to another agent. After it lands, extend the combined
fixtures/resource run and tool/version documentation to Knip, rerun final
gates and smoke checks, then close `trellis-639c`, `trellis-8ac1` and the
plan. Do not infer milestone completion from the other 28 closed children.

The local work commits are `0aca9ac` (acceptance), `4fbac2d` (documentation)
and `9e7fd56` (tracker handoff). Other agents' uncommitted tracker/memory
edits were preserved and are not part of this acceptance claim. Nothing
was published or pushed.
