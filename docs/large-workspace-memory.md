# Large-workspace audit memory profile (trellis-92b4)

Recorded 2026-09-25 on Linux x64 (4 vCPU, 16 GiB), Bun 1.3.11, TypeScript
6.0.3, analyzer 0.3.0 plus the unreleased changes on this branch. Scoring is
unchanged; nothing here changes default audit behavior.

## Reproduce

```bash
git clone --depth 1 https://github.com/microsoft/vscode.git   # measured at bda2b9e7
bun run scripts/profile-audit.ts vscode/src/vs/platform --out profile.json
```

`scripts/profile-audit.ts` runs `auditWorkspace` in-process and, at every
progress event, forces two full GCs and records the **retained** JS heap and
the process RSS. After the audit it sizes the report, one zod-parsed copy,
and compact/pretty JSON. Forced GCs slow the run, so its wall times are not
runtime budgets.

## Results

| Workspace | Files | Functions | Peak RSS | Heap at `syntax-built` | Heap added by all analyzers | Report heap | JSON compact / pretty |
|---|---|---|---|---|---|---|---|
| trellis (self) | 383 | 5,341 | 434 MiB | 129 MiB | +5 MiB | 0.2 MiB | 0.3 / 0.5 MiB |
| vscode `src/vs/platform` | 2,737 | 58,483 | 2,092 MiB | 1,391 MiB | +17 MiB | 2.3 MiB | 4.6 / 6.8 MiB |
| vscode `src/vs/workbench/contrib` | 3,097 | 93,591 | 3,186 MiB | 2,211 MiB | +35 MiB | 9.2 MiB | 17.1 / 25.1 MiB |

The earlier Warren measurement (1,603 files, 23,092 functions, 1,624 MiB
peak RSS on macOS ARM64; 17.4 MB compact report) fits the same shape.

## Attribution

1. **The shared parse dominates.** Retained heap jumps at `syntax-built` and
   stays flat through measurement: complexity, graph, duplication and cycles
   together add 1–2% (duplication's clone context is the largest share).
2. **Half of the parse cost is TypeScript's child-list cache, not the AST.**
   A standalone probe over `src/vs/platform` (30 MiB of source) retains
   679 MiB after `ts.createSourceFile(…, setParentNodes)` and **1,403 MiB**
   after one full `node.getChildren()` walk. `getChildren` builds
   `SyntaxList`/token nodes for every node and caches them in a module-level
   `WeakMap` keyed by source file. The function inventory
   (`src/syntax/functions.ts`) walks with `getChildren` during parse, so
   every file's full token tree stays alive for the whole audit.
3. **Nothing leaks across audits.** Three back-to-back audits in one process
   return to ~20 MiB retained heap; the AST is released when the audit
   returns.
4. **Report and serialization are small.** The finished report retains a
   few MiB; a zod-parsed copy and JSON serialization are transient (under
   0.4 s at 17 MiB compact JSON). They are not where peak memory goes.

## Reproducible target

Baseline for `src/vs/platform` at vscode `bda2b9e7`: **2.1 GiB peak RSS**.
The trellis-self 1 GiB corpus budget does not cover workspaces of this size.

Proposed target: **≤ 1.3 GiB peak RSS** on the same input, by not retaining
per-file child-list caches across the audit (e.g. walking with
`ts.forEachChild` where tokens are not needed, and releasing a file's cache
after its token stream is collected). That is a retention change, so it must:

- keep every native metric, clone membership, identity and score
  byte-identical on the fixed corpus and trellis-self;
- keep default audits offline and write-free;
- land as its own versioned change with before/after profiles from this
  script.

Tracked as follow-up `trellis-576f`.
