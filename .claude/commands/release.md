---
name: release
---

## body

Analyze all changes since the last release and prepare a new version.

Steps:

1. Find the last release tag: `git describe --tags --abbrev=0 2>/dev/null || echo "none"`
2. If there's a previous tag, review changes: `git log <tag>..HEAD --oneline` and `git diff <tag>..HEAD`
3. Determine the version bump level. **Always use patch unless the user explicitly requests minor or major.** (trellis is pre-1.0: breaking changes go in minor, additive changes in patch.)
4. Bump the version in both `package.json` (`"version"` field) and `src/index.ts` (`export const VERSION = "X.Y.Z"`) by editing each file directly. There is no `bun run version:bump` script in this repo; the publish workflow (`.github/workflows/publish.yml`) fails if the two values disagree.
5. Update `CHANGELOG.md` — move items from `[Unreleased]` to a new `[X.Y.Z] — YYYY-MM-DD` section grouped under Added / Changed / Fixed / Deprecated / Removed / Security.
6. Update `CLAUDE.md` if command counts, the module layout, or conventions changed.
7. Update `README.md` if the CLI reference, install instructions, or stats changed.
8. Run the gate suite (`bun run lint && bun run typecheck && bun test && bun run check:all`) and confirm it exits 0.
9. COMMIT YOUR CHANGES (`release: trellis X.Y.Z`)! Then present a summary of all changes made. Do not push unless the user asks; pushing `main` triggers the version-gated publish.
