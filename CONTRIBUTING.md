# Contributing to trellis

Thanks for your interest in contributing to trellis! This guide covers
everything you need to get started. If you are an AI coding agent, read
[`AGENTS.md`](AGENTS.md) first — it is the canonical agent guide.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/trellis.git
   cd trellis
   ```
3. **Install** dependencies (Bun ≥ 1.1):
   ```bash
   bun install
   ```
4. **Link** the CLI for local development:
   ```bash
   bun link        # then `trellis --help`
   ```
5. **Create a branch** for your work:
   ```bash
   git checkout -b feat/description-of-change
   ```

## Branch Naming

Use descriptive branch names with a category prefix:

- `fix/` — Bug fixes
- `feat/` — New features
- `docs/` — Documentation changes
- `refactor/` — Code refactoring
- `test/` — Test additions or fixes

## Build & Test Commands

```bash
bun test                      # run all tests
bun test src/scoring/index.test.ts   # run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run lint:fix              # biome check --write --error-on-warnings .
bun run typecheck             # tsc --noEmit
bun run check:all             # all quality gates
```

Always run `bun run check:all` before submitting a PR.

## Architecture Discipline (api>cli>sdk)

trellis keeps **all behavior in one surface-agnostic domain core** (`src/`
modules); the CLI (`src/cli/`) and SDK (`src/client/`) are thin pass-throughs
(SPEC §13.1). When you add behavior:

- Put the logic in the appropriate core module, never in `cli/` or `client/`.
- The **rubric (WHAT) never names a tool.** Tool-specific checks go in
  `detectors/` adapters (`common/`, `lang/{typescript,swift,python}/`,
  `oseco/`), bound to criteria via `detectors/registry.ts`.
- SDK types **mirror** the core's exported types (annotate `// Mirrors src/<x>`).

## TypeScript Conventions

- **Strict mode** with `noUncheckedIndexedAccess` — handle possible `undefined`
  from indexing.
- **No `any`** — use `unknown` and narrow; validate external input with zod.
- **Tab indentation, 100-char line width** (Biome enforces).
- **Import with `.ts` extensions.** Filenames are `kebab-case.ts`.
- Use Bun built-ins where possible (`bun:sqlite`, `Bun.file`/`Bun.write`,
  `Bun.spawn`).

## Testing Conventions

- **No mocks for filesystem or SQLite.** Use real temp dirs (`mkdtemp`) and
  `:memory:`/temp-file databases. Clean up in `afterEach`.
- The only stub boundary is the **Pi RPC process** — capture and canonicalize
  sessions into `__golden__/` and run the parser → zod → grader chain fully
  offline (SPEC §9.7). Regenerate goldens only via the documented update gate.
- Tests are colocated: `src/foo.test.ts` beside `src/foo.ts`.
- `describe("<unitUnderTest>")` + `test("verb-led behaviour")` — no `should`,
  no `it`.

## Adding a Detector

1. Implement against the `DetectorResult` contract (SPEC §8.1) in the right
   adapter under `src/detectors/`.
2. Bind it to its criterion id in `src/detectors/registry.ts`.
3. Observe the `not-applicable` vs `no-detector` discipline — never silently
   pass an unimplemented check.
4. Add tests with real fixture repos under a temp dir.
5. Update the rubric/docs if criterion coverage changed.

## Commit Message Style

Use concise, descriptive messages prefixed by area:

```
scoring: clamp coverage at category boundary
detectors: add knip undeclared-deps check for the TS adapter
docs: document targets.yaml allowed-deltas
```

`fix:` / `feat:` / `docs:` prefixes are also fine when the category is clear.
One concern per commit.

## Pull Request Expectations

- **One concern per PR.** A bug fix, a feature, or a refactor — not all three.
- **Tests required.** New features and bug fixes ship with tests.
- **Passing CI.** All PRs must pass `check:all` (lint + typecheck + test +
  ratchets) before merge.
- **Description.** Explain what the PR does and why; link relevant Seeds
  (`trellis-XXXX`) or GitHub issues.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/trellis/issues) for bug
reports and feature requests; day-to-day work is tracked in Seeds
(`.seeds/`). For security vulnerabilities, see [`SECURITY.md`](SECURITY.md) —
do **not** open a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
