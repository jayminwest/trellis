# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While pre-1.0, breaking changes go in MINOR and additive changes go in PATCH.

## [Unreleased]

### Added

- `.github/` governance & CI surface: `dependabot.yml` (cooldown / delayed
  adoption), issue templates (`bug_report`, `feature_request`, `config`),
  `pull_request_template.md`, `labels.yml`, and workflows `ci.yml`
  (verbatim `check:all` parity with the local gate + `test:ci`, report
  summaries, and JUnit/lcov artifact uploads), `sync-labels.yml`,
  `publish.yml` (version-gated `@os-eco/trellis-cli` publish with provenance
  and `package.json` ↔ `src/index.ts` VERSION-sync assertion), and
  `auto-merge.yml`. Adds `report:test-timing` / `report:quality-metrics`
  package scripts the CI report steps invoke. (`trellis-7baf`)
- Governance & agent-instruction surface: `README.md`, `AGENTS.md`,
  `CLAUDE.md`, `CHANGELOG.md`, `CODEOWNERS`, `CONTRIBUTING.md`, `SECURITY.md`,
  `RUNBOOK.md`, `docs/architecture.mmd`, and `.claude/commands/`
  (`release`, `pr-reviews`, `issue-reviews`, `prioritize`). (`trellis-03a9`)
- `package.json` quality-gate script wiring (`check:*` family, `test:ci`,
  `prepare`); the backing ratchet scripts and budgets land with the L5 toolkit.
  (`trellis-03a9`)
- Bun + TypeScript-strict skeleton, os-eco baseline configs, and the `src/`
  module tree per SPEC §4. (`trellis-b636`)
