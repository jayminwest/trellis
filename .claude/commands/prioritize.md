---
name: prioritize
---

## description

Analyze all open issues across GitHub Issues and Seeds, cross-reference with codebase health, and recommend the top ~5 issues to tackle next.

**Argument:** `$ARGUMENTS` — optional: a label or area to focus on (e.g., `detectors`, `scoring`, `metrics`, `standards`). If empty, analyze everything.

## gather-issues

Use the Task tool to spawn **three parallel agents**:

### Agent A: GitHub Issues
- Run `gh issue list --state open --limit 50 --json number,title,author,labels,createdAt,updatedAt,body`
- For each issue, capture: number, title, labels, author, creation date, body summary
- Note any issues with community engagement (comments, thumbs-up, external authors)

### Agent B: Seeds Issues
- Run `sd list` and `sd ready`
- For each open issue, run `sd show <id>` to get full details
- Capture: id, title, type, priority, status, description, dependencies/blockers
- Build a dependency graph: which issues block which (trellis ships as a seeds plan — respect plan ordering)

### Agent C: Codebase Health
- Run `bun test` and capture pass/fail counts
- Run `bun run lint` and capture error counts
- Run `bun run typecheck` and capture error counts
- Run `bun run check:all` and capture which gate (size/debt/dups/deps/agents/coverage) fails, if any
- Search for `TODO`, `FIXME`, `HACK`, `XXX` comments and count them (flag any without a tracker reference)
- Check which source files lack test coverage (compare `src/**/*.ts` vs `src/**/*.test.ts`), and which criteria still resolve `no-detector`
- Summarize: is the codebase healthy, or are there quality issues that need attention

## cross-reference

After all three agents complete:

- **Deduplicate**: Match GitHub issues to Seeds issues that describe the same work (same title, overlapping description, related files / criterion ids)
- **Dependency mapping**: Identify chains — issues that must be done before others can start (honor the seeds plan graph)
- **Cluster detection**: Group related issues that could be tackled together (same subsystem, same language adapter, same rubric category)
- **Staleness check**: Flag issues that have been open a long time with no activity

## scoring

For every unique issue (deduplicated), assess:

### a. Impact
- Does it fix a bug that blocks audits or produces wrong scores?
- Does it enable new capabilities or unblock other work (e.g. a new metric, the shared parse layer, the store)?
- How many other issues does it unblock (dependency graph)?
- Does it affect external users (GitHub issues from community) or the dogfood gate?

### b. Feasibility
- Is it well-scoped with clear acceptance criteria?
- How many files/subsystems does it touch? (Small: 1-2, Medium: 3-5, Large: 6+)
- Are there prerequisite changes needed first?
- Can it be done independently or does it require coordination across adapters / the core?

### c. Complexity
- Is the change localized or does it cut across multiple subsystems (rubric, detectors, scoring, store, report, fleet)?
- Does it affect rubric comparability (RUBRIC_VERSION) or the SQLite schema (migrations)?
- Are there merge conflict risks with other candidate issues?
- Does it need human judgment or can it be handled autonomously?

### d. Urgency
- Is it blocking active development, the seeds plan, or the dogfood gate?
- Is it a regression from a recent release?
- Has it been reported by external users?
- Does codebase health data (failing tests, lint/typecheck/check:all errors) point to it?

## deep-dive

Before finalizing recommendations, check if any high-scoring issues need more investigation:

- **Ambiguous scope**: If an issue's file scope is unclear, use Grep/Glob to trace the affected code paths and estimate the real blast radius
- **Hidden dependencies**: If an issue looks independent but touches shared code (rubric schema, scoring, registry, store), check what else depends on those files
- **Conflict risk**: If two candidate issues touch overlapping files, read those files to assess whether parallel work would cause merge conflicts
- **Stale context**: If an issue references old code or merged PRs, verify the problem still exists

Spawn additional Task agents for any deep-dives needed. Don't recommend issues you haven't validated.

## recommendations

Present a final prioritized recommendation:

### Summary Table

| Rank | Issue ID | Title | Source | Type | Scope | Score | Why |
|------|----------|-------|--------|------|-------|-------|-----|

### Detailed Rationale

For each recommended issue:
- **Issue:** `<id> — <title>`
- **Source:** GitHub #N / Seeds <id> / Both
- **Type:** Bug / Feature / Test / Refactor / Docs
- **Priority:** Critical / High / Medium
- **Scope:** Small / Medium / Large — list key files
- **Dependencies:** What must be done first, what this unblocks
- **Rationale:** 2-3 sentences on why this should be next

### Batch Coherence Check
- Do the recommended issues work well together as a batch?
- Are there merge conflict risks between them?
- Is the total scope realistic?
- Suggest an execution order if sequencing matters

### Deferred Issues
- List the top 5 issues that almost made the cut, with brief reasons for deferral
- Note any issues that should be closed (stale, duplicate, wontfix)

### Observations
- Cross-cutting themes across the issue landscape
- Areas of the codebase accumulating technical debt
- Suggestions for issues that should be filed but don't exist yet
