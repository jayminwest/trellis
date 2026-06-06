# RUNBOOK.md

Operational procedures for `trellis`. For day-to-day development conventions
see [`AGENTS.md`](AGENTS.md); for architecture see
[`docs/architecture.mmd`](docs/architecture.mmd) and [`SPEC.md`](SPEC.md).

This runbook covers:

1. Cutting a release.
2. Triaging a failed publish.
3. Rolling back a bad release.

Key facts:

- **Package:** `@os-eco/trellis-cli`
- **Primary branch:** `main`
- **Release workflow:** `.github/workflows/publish.yml` (version-gated; lands
  with seeds `trellis-7baf`)
- **Version sources (must agree):** `package.json` `"version"` and
  `src/index.ts` `export const VERSION`
- **Changelog:** `CHANGELOG.md`
- **Tracker prefix:** `trellis-`

## Pre-flight (do once per machine)

- `bun --version` ≥ the version in `package.json` `engines.bun`.
- `gh auth status` → authenticated, with `repo` + `workflow` scopes.
- `git remote -v` shows the canonical origin.
- For npm publish: `npm whoami` → publisher account; 2FA enabled.
- Local working tree on `main`, fully up to date, `git status` clean.

## 1. Release procedure

Cut releases from `main` only. Never tag a feature branch. The `/release`
slash command (`.claude/commands/release.md`) automates §1.1–§1.4.

### 1.1 Decide the version

Follow [SemVer](https://semver.org). trellis is pre-1.0 while `package.json`
"version" starts with `0.`; while pre-1.0, breaking changes go in MINOR and
additive changes go in PATCH. Default to **PATCH** unless explicitly bumping
minor/major.

### 1.2 Update the version in every source of truth

`package.json` and `src/index.ts` must agree — the release workflow fails the
job if they disagree.

```bash
# bump package.json
sed -i '' 's/"version": ".*"/"version": "X.Y.Z"/' package.json
# bump src/index.ts: export const VERSION = "X.Y.Z";
```

Use `git diff` to confirm both moved. Commit:

```bash
git add package.json src/index.ts
git commit -m "release: trellis X.Y.Z"
```

### 1.3 Update the changelog

`CHANGELOG.md` must have a dated entry for the new version at the top, with
items moved out of `[Unreleased]`:

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Group under standard headings (Added / Changed / Fixed / Deprecated / Removed /
Security). Link entries to `trellis-XXXX` or `#NNN`. Commit (or squash with the
version commit — be consistent):

```bash
git add CHANGELOG.md
git commit -m "release: changelog for X.Y.Z"
```

### 1.4 Final gate check

```bash
bun install
bun run lint
bun run typecheck
bun test
bun run check:all
```

All must exit 0. If any fails, **stop** — fix locally and re-run.

### 1.5 Push to main

```bash
git push origin main
```

Pushing triggers `.github/workflows/publish.yml`, which:

1. Re-runs the gate suite in CI.
2. Asserts `package.json` and `src/index.ts` agree on `X.Y.Z`.
3. Builds + publishes `@os-eco/trellis-cli` to npm (with provenance).
4. Tags `vX.Y.Z` and creates a GitHub release with the `CHANGELOG.md` section
   as the body.

Watch it live:

```bash
gh run watch
```

### 1.6 Post-release sanity

```bash
git pull --tags
git tag --list | tail -5             # confirm vX.Y.Z is present
gh release view vX.Y.Z               # confirm release page renders
npm view @os-eco/trellis-cli version # confirm the published version
```

Smoke-install in a clean dir:

```bash
mkdir /tmp/trellis-smoke && cd /tmp/trellis-smoke
bun install @os-eco/trellis-cli
bunx @os-eco/trellis-cli --version
```

## 2. Triage of a failed publish

When `.github/workflows/publish.yml` exits non-zero:

### 2.1 Read the log

```bash
gh run view --log-failed
```

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `version mismatch` | `package.json` / `src/index.ts` disagree | Sync versions, push fix commit. |
| `npm publish ... 403` | Missing/expired `NPM_TOKEN` secret | Settings → Secrets → update `NPM_TOKEN`, re-run. |
| `npm publish ... E409` | Version already published | Bump to next patch; do **not** unpublish a live version. |
| `gh release create ... already exists` | Tag exists, prior run left an incomplete release | Delete the orphan release in the UI, re-run. |
| `tsc` / `biome` / `bun test` failure | Local greens diverged from CI | Reproduce with `bun run check:all`; do **not** force-push to `main`. |

### 2.2 Re-run the workflow

After the fix commit lands on `main`:

```bash
gh workflow run publish.yml --ref main
```

Or push a no-op commit (`git commit --allow-empty -m "release: retry"`) if the
workflow only triggers on push.

### 2.3 If the publish half-succeeded

If npm publish completed but `gh release create` failed (or vice versa), **do
not unpublish**. Instead:

- Create the missing GitHub release manually:
  ```bash
  gh release create vX.Y.Z --notes-file <(awk '/^## \[X.Y.Z\]/,/^## \[/' CHANGELOG.md)
  ```
- Or, if npm has the version but the tag is missing:
  ```bash
  git tag vX.Y.Z && git push origin vX.Y.Z
  ```

Record the deviation in `trellis-XXXX`.

## 3. Rollback

A "rollback" never means unpublishing — npm and git tags are immutable.
Rollback means **publishing a corrective version**.

### 3.1 Decide the severity

- **Critical** (data loss, security, total breakage): cut a new patch reverting
  the change, under 30 minutes.
- **High** (regression on a common path): cut a patch within the day.
- **Medium/Low**: fix forward on the next planned release.

### 3.2 Revert the offending commits

```bash
git checkout main && git pull
git log --oneline -10
git revert <bad-sha>           # new commit, preserves history
```

### 3.3 Cut a follow-up release

Follow §1.1–§1.5. Note the rollback explicitly in `CHANGELOG.md`:

```markdown
## [X.Y.(Z+1)] — YYYY-MM-DD

### Fixed
- Reverted <bad-commit-summary> from X.Y.Z which caused <symptom>.
  Tracking in trellis-XXXX.
```

### 3.4 Deprecate the bad version on npm

If the bad version is dangerous:

```bash
npm deprecate @os-eco/trellis-cli@X.Y.Z "Critical bug; install X.Y.(Z+1) or later. See CHANGELOG.md."
```

`npm deprecate` does not remove the version (which would break deterministic
installs); it surfaces a warning at install time.

### 3.5 Communicate

- Add a banner to the GitHub release notes for `vX.Y.Z`:
  `> ⚠️ This release contains a regression. Use vX.Y.(Z+1) or later.`
- File `trellis-XXXX` with root cause + remediation links.

## 4. Regenerating investigation goldens (SPEC §9.7)

The investigation layer is tested offline against frozen `pi --mode rpc`
sessions under `src/investigation/__golden__/` — one `<area>.jsonl` per area plus
a `corrupted.jsonl`. `golden.test.ts` replays each stream through the real
parser → zod validation → deterministic grader with **no network**. Until a live
capture exists the fixtures are **hand-authored** to the v0.74.0 wire shape
(marked in `__golden__/README.md`).

### 4.1 When to regenerate

- The Pi RPC envelope shape changes (a supported-version bump in `version.ts`).
- A findings schema (`findings.ts`) changes the `submit_findings` argument shape.
- You are replacing a hand-authored fixture with a real captured session.

### 4.2 How to regenerate (operator, makes real model calls)

Capture is **double-gated** so CI can never trigger a model call — it refuses
unless both the env flag and `--live` are present:

```bash
# All four areas, against this repo:
TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live

# A single area, against another checkout:
TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live \
  --area documentation --repo /path/to/repo
```

Requires a working `pi` on `PATH` (>= the version in `version.ts`) and the
provider credentials in the environment (e.g. `ANTHROPIC_API_KEY`, or `pi
/login`). Each area is investigated through the real provider path; the raw
stdout stream is canonicalized (volatile ids/timestamps/usage → fixed
placeholders) and frozen.

### 4.3 After regenerating

1. Re-read the diff — only the captured **facts** should change, never the
   placeholders.
2. Update the `EXPECTED_GRADES` in `src/investigation/golden.test.ts` to match
   the new facts, then `bun test src/investigation/golden.test.ts`.
3. Run it twice — goldens must grade identically across consecutive runs.
4. `bun run check:all` and commit the `__golden__/` change with the test update.

## Appendix — Common commands

```bash
# Inspect recent releases
git tag --sort=-creatordate | head -5
gh release list --limit 5

# Inspect a failing workflow run
gh run list --workflow=publish.yml --limit 5
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed
```

## Appendix — Pre-publish checklist (copy into the release PR body)

- [ ] `package.json` + `src/index.ts` updated to X.Y.Z and in agreement.
- [ ] `CHANGELOG.md` has a dated `[X.Y.Z]` section.
- [ ] `bun run check:all` exits 0 locally.
- [ ] `gh run watch` confirmed the release workflow succeeded.
- [ ] `npm view @os-eco/trellis-cli version` reports X.Y.Z.
- [ ] Smoke install in a clean dir succeeds.
- [ ] GitHub release page renders the changelog section correctly.
