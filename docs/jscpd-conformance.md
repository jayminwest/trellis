# jscpd provider conformance record (trellis-b0ec, plan `pl-43c5` step 14)

**Status: delivered.** The bounded conformance and failure-regression record
for the jscpd provider: the pinned-mode adapter and raw validation
(`src/providers/jscpd/adapter.ts`, `mode-run.ts`, `invocation.ts`, `raw.ts` —
steps 9–12) and the normalization into clone evidence and trellis-owned line
accounting (`normalize.ts`, `evidence.ts`, `lines.ts` — step 13). The
maintained tests are the harness; this page records what they prove, the
observed environment, and the retained leads.

This is **not** a precision/recall benchmark, **not** a score input
(provider evidence stays unscored, SPEC §16.5), and **not** an all-platform
guarantee: it records what was actually exercised, where, and how repeatable
it was (SPEC §16.2 — observations are evidence, never cleanliness).

## Method

Every real-binary test resolves the pinned artifact through
`src/providers/resolve.ts`, runs it only through the controlled process
runner (`src/providers/process.ts`) over a staged source view
(`src/providers/workspace.ts`), offline, in throwaway temp workspaces with
**no dependencies, no manifests, and no Git** — trellis-owned scratch is
cleaned on every exit path, and the target workspace is only ever read.
Tests that need the pinned binary are skipped (`test.skipIf`) where it is
not installed — never fabricated. Bounded execution: the 20 s per-test
runner timeout (`bunfig.toml`) and the adapter defaults (60 s wall time,
1 MB per output stream per process).

Forced failures a healthy pinned binary cannot produce on its own — a
malformed JSON report, a schema-violating report, exit 0 with no report —
run through a stub at the **true external process boundary** (the only
seam the repo's test conventions allow stubbing), still through the
controlled runner over a staged view.

## Where the tests live

| suite | covers |
| --- | --- |
| `src/providers/jscpd/conformance.test.ts` | the five authored controls (explicit expected evidence) and the bounded-corpus repeat |
| `src/providers/jscpd/conformance-inputs.test.ts` | TSX/templates/regex, malformed syntax, below-threshold coverage, mixed source sets, scope exclusion, target-owned configuration, within-file repeats |
| `src/providers/jscpd/conformance-failures.test.ts` | wall-time/output limits, missing executable, cancellation, malformed and schema-violating reports, exit 0 without a report, lifecycle timeout, cleanup failure |
| `src/providers/jscpd/{adapter,mode-run,normalize,raw}.test.ts` | the step 12–13 unit and pinned-argv regressions (closed steps, unchanged) |

The shared corpus, fixtures, and staged-run harness live in
`src/providers/jscpd/conformance.ts`. No clone fixture is ever checked in
as two source files: pairs are authored once and staged into temp
workspaces at test time.

## Controls (explicit expected evidence)

The five labeled research controls (inputs:
`docs/research/jscpd-provider-spike/fixtures.json`), each staged as a
fresh two-file workspace and run through the adapter in all three modes,
then normalized:

| control | `exact` mode | `normalized` mode | `near` mode | trellis accounting (production) |
| --- | --- | --- | --- | --- |
| identical copy | 1 exact pair, a.ts:1–14 ~ b.ts:1–14 | same record, exact pair | same | 28/28 affected code lines of 28 |
| renamed copy | 0 pairs (complete) | 1 normalized pair, 1–14 | same record, normalized pair | 28/28 of 28 |
| edited copy (one inserted line) | 0 pairs (complete) | 0 pairs (complete) | 1 near pair, a:1–14 ~ b:1–15 (columns 8+, `method: ast`, `similarity: 0.867`) | 29/29 of 29 |
| unrelated pair (both above threshold) | 0 pairs | 0 pairs | 0 pairs | 0 of 21 |
| idiomatic pair (ambiguous lead) | 0 pairs | 1 normalized pair, 1–11 | same record, normalized pair | 22/22 of 22 |

Raw facts are preserved on every finding (`rawKind`, `format`, `lines`,
`tokens`, near-miss `method`/`similarity`); the provider's own totals stay
explanation-only (`rawTotals`), never the trellis metric.

### Leads (recorded, not ground truth)

- **The idiomatic pair is ambiguous by authorship**: two independent data
  builders with matching structure. The tests record what the pinned tool
  observes (a normalized pair) without asserting it as a true duplication
  finding — structural similarity alone does not establish shared
  responsibility or justify an abstraction.
- **The corpus near-mode cross-case pairs** (18 pairs, including
  `similar` matches between the exact and renamed controls) are the
  pinned tool's nontransitive near-matching over repeated related
  content. They are recorded as observed behavior; near evidence stays
  pair-only and never forms or joins groups.

## Input surfaces

| input | observed conformance |
| --- | --- |
| TSX (template literals, regex literals) | analyzed as its own format (`formats: ["tsx"]`), exact pair over the whole component; trellis classifies the staged TSX for accounting |
| malformed syntax **above** the token threshold | the lenient tokenizer counts the broken files as sources (coverage reconciles: complete); the two identical malformed copies pair exactly; the trellis classifier still accounts them — but the tool's **AST-similarity matcher never pairs an unparseable file with a valid one** (the near mode reports only the token-exact malformed pair). Parser support is never inferred from exit 0 |
| a below-threshold file | omitted from the tool's source statistics → **incomplete** with the coverage account (selected/reported/omitted), no enumerated analyzed files, and the above-threshold pair still visible |
| mixed production/test source sets | one cross-set pair, accounted in each set's own ledger (14/14 production, 14/14 test) |
| scope exclusion | only the staged selection reaches the tool: an identical unselected third file never appears in evidence or in the staged copy |
| target-owned provider configuration | a hostile ancestor `.jscpd.json` (ignore all, sky-high token threshold) never changes the run — the adapter's owned empty config wins; the target is read-only |
| within-file duplication | a same-path pair (x.ts:1–14 ~ x.ts:16–29) whose covered lines union **once per file** (28, not 14+14) |
| no-dependency, non-Git workspaces | staging and every mode run complete over plain untracked files — no `package.json`, `node_modules`, or Git consulted or needed |

## Failure regressions (never a clean result)

| forced condition | asserted result |
| --- | --- |
| wall-time limit exhausted (1 ms) | `unavailable`, reason "wall-time limit … exceeded; process group terminated", no report, no analysis |
| output limit exhausted (16 bytes) | `unavailable`, reason "… exceeded the 16-byte limit; output truncated and process group terminated", no report |
| executable path unresolvable | `unavailable` (ENOENT), no report |
| caller cancelled before start | `unavailable`, reason "cancelled before start; nothing was executed", no report |
| malformed raw report (not JSON), exit 0 | `incomplete`, "raw jscpd report failed validation … not valid JSON", no report |
| schema-violating raw report (a `similar` clone without method/similarity) | `incomplete`, located schema reason, no report |
| exit 0, no report written | `incomplete`, "exited 0 but wrote no readable JSON report" |
| provider error exit (reporter cannot write) | `incomplete`, exit code and bounded diagnostics (step 12 suite) |
| missing pinned tool installation | `unavailable` per mode with install instructions (step 12 suite) |
| lifecycle wall-time limit (staged run) | outcome `timeout` with owned scratch cleaned on the timeout exit path |
| scratch cleanup failure | the adapter's evidence value wins; the cleanup failure is reported (`cleanup: failed`), never silently dropped |

## Repeat, environment, and feasibility observations

Environment of the recorded run:

| fact | value |
| --- | --- |
| platform (manifest key) | `linux-x64-gnu` (linux x64, glibc) |
| pinned tool / adapter / parser | jscpd 5.2.1 / 0.1.0 / `jscpd.tokenizer` |
| trellis-side parser | typescript 6.0.3 (exact pin; the accounting classifier) |
| runtime | Bun 1.2.23 |
| machine | Intel Xeon @ 2.20 GHz (8 visible cores), Linux container |
| repo revision at the record | `c5c4bca` |

- **Repeatability.** The bounded corpus (12 files: the five controls plus
  the TSX pair) was run three times through the full adapter; every mode
  normalized to **byte-identical evidence** (the volatile
  `detectionDate` never enters the normalized product), with identical
  provider/analysis identities across repeats and distinct option sets
  across modes. This is repeatability for these inputs, options, and
  platform — not a universal determinism claim (the spike's risk 8).
- **Runtime.** Full three-mode adapter run over the corpus: median
  ≈ 82 ms per repeat (warm; a cold first run measured ≈ 433 ms); the
  version check plus one exact-mode run ≈ 53 ms.
- **Peak memory.** One jscpd provider process over the staged corpus:
  sampled peak RSS ≈ 6.7 MiB (VmHWM sampled at 2 ms intervals; lifetime
  VmPeak ≈ 465 MiB is reserved virtual address space, not residency).
  The measurement harness process (Bun + TypeScript + children) peaked at
  ≈ 278 MiB. Method note: the controlled runner exposes no pid, so the
  child peak was observed with a measurement-only spawn of the same
  pinned argv — recorded as an observation, not a gate.
- **Feasibility budget.** Observed per-mode walls sit more than two orders
  of magnitude inside the enforced bounds (20 s per-test runner timeout,
  60 s default process wall time). The budget is stated here rather than
  asserted as a CI timing check — wall-clock asserts are
  environment-sensitive, and the deterministic bound is the per-test
  timeout: a measurement that exhausts a limit is asserted `unavailable`
  and never scores as clean.

## Scope and compatibility statements

- **One recorded platform.** This record exercises `linux-x64-gnu`. The
  manifest records darwin-arm64 as `research-tested` (the spike) and other
  declared platforms as `declared-untested`; nothing here claims them.
- **No equivalence across differently scoped work.** The spike's production
  observations (162 files: trellis 124 normalized groups / 2,320 affected
  lines vs jscpd 24 exact pairs / 452 and 91 normalized pairs / 1,565) are
  a different corpus, scope, and comparison — they are not compared with
  or reconciled against this conformance corpus, and neither number is
  promoted into any score.
- **Unscored.** Nothing in this record changes native analysis, scoring,
  or default-audit behavior; provider evidence remains namespaced and
  advisory until separately versioned calibration decisions say otherwise
  (SPEC §16.5).
