---
name: pr-reviews
---

## intro

Review open pull requests for code quality, project alignment, and risks.

**Argument:** `$ARGUMENTS` — optional PR number(s) to review (e.g., `9` or `9 12 15`). If empty, review all open PRs.

## Steps

### 1. Discover PRs to review

- If `$ARGUMENTS` contains PR number(s), use those
- Otherwise, run `gh pr list --state open --json number,title,author,headRefName,additions,deletions` to get all open PRs
- If there are no open PRs, say so and stop

### 2. Spawn a review team

Use the Task tool to spawn parallel agents (one per PR). Each agent should:

#### a. Gather context
- `gh pr view <number> --json title,body,author,additions,deletions,files,commits,comments,reviews,headRefName,baseRefName`
- `gh pr diff <number>` to get the full diff
- Read any files touched by the PR to understand the surrounding code

#### b. Code quality review
- Check for correctness — does the code do what the PR claims?
- Check for bugs, edge cases, and error handling gaps
- Check adherence to project conventions (see `CLAUDE.md` / `AGENTS.md`): strict TypeScript (`noUncheckedIndexedAccess`, no `any`), zod at boundaries, Biome formatting, tab indentation, 100-char line width, `.ts` import extensions, `kebab-case` filenames
- **Architecture discipline (SPEC §13.1):** verify all behavior lives in the core `src/` modules and that `src/cli/` + `src/client/` stay thin pass-throughs — no logic leaking into a surface. Confirm SDK types still mirror the core (`// Mirrors src/<x>`).
- **Native scoring seam:** metrics consume the shared syntax inventory; safeguards and provider evidence never enter the score.
- Check test coverage — are new code paths tested? Do tests follow the "no mocks for fs/SQLite, stub only external process boundaries" philosophy? Are golden fixtures under `__golden__/` regenerated only via the update gate?
- Flag any security concerns (path traversal on audited repos, credential leakage through pino logs / the store / reports, unsafe execution of audited-repo code)

#### c. Project alignment review
- Does this change fit trellis's architecture and direction (SPEC)?
- Does it follow existing patterns or introduce unnecessary new ones?
- Is the scope appropriate — does it do too much or too little?
- Does it preserve explicit incomplete/unavailable analysis states and analyzer/scoring compatibility where relevant?
- Are there breaking changes to the CLI surface, exit-code contract, or report shapes?

#### d. Risk assessment
- What could go wrong if this is merged?
- Are there performance implications (large fleets, large syntax inventories, provider processes)?
- Does it touch critical paths (metric contracts, scoring, drift matchers, SQLite migrations, provider runner)?
- Could it change scores in a way that breaks comparability with historical runs?
- Could it conflict with other open PRs?

#### e. Produce a review summary
Each agent should return a structured review:
- **PR:** `#<number> — <title>` by `<author>`
- **Verdict:** Approve / Request Changes / Needs Discussion
- **Summary:** 2-3 sentence overview
- **Strengths:** What's good about this PR
- **Issues:** Bugs, risks, or concerns (with file:line references)
- **Suggestions:** Non-blocking improvements
- **Project alignment:** How well it fits trellis's direction

### 3. Present consolidated report

After all agents complete, present a single consolidated report with:
- A summary table of all reviewed PRs with verdicts
- The detailed review for each PR
- Any cross-PR concerns (conflicts, overlapping changes, pattern inconsistencies)
- Recommended merge order if multiple PRs are ready
