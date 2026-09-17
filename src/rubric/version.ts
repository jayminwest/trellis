/**
 * Rubric version + comparability policy (SPEC §3.5).
 *
 * The rubric is a **versioned artifact** (`rubric@X.Y.Z`), semver'd by
 * *comparability impact* — what a version bump does to an existing repo's
 * score for unchanged code — NOT by code semantics. Every scorecard records
 * "Level X against rubric vN" so a repo dropping a level is provably a real
 * regression, never a silently-tightened rubric.
 *
 * Comparability policy:
 *
 *   major — can move an existing repo's score for unchanged code: a criterion
 *           removed or re-leveled, a gate flipped, or the threshold / leveling
 *           math changed. Breaks historical comparability.
 *   minor — purely additive: a new criterion or category. Old criteria score
 *           identically; only app-scope `N` denominators grow.
 *   patch — wording only, no scoring impact.
 *
 * Pre-1.0, comparability-affecting changes ride in the **minor** slot (there is
 * no major to break yet), so a minor bump before 1.0.0 may move scores. Post-1.0
 * the table above is binding.
 */
export const RUBRIC_VERSION = "0.3.0";

/**
 * Compare two rubric versions for *score comparability*.
 *
 * Two runs are directly comparable only when they share a major version (and,
 * pre-1.0, a minor version — since comparability changes ride the minor slot
 * before there is a major to break). Returns `true` when scores from `a` and
 * `b` can be compared without rubric-version caveats.
 */
export function comparable(a: string, b: string): boolean {
	if (a === b) return true;
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa.major !== pb.major) return false;
	// Pre-1.0: comparability rides the minor slot, so differing minors are
	// not directly comparable.
	if (pa.major === 0 || pb.major === 0) return pa.minor === pb.minor;
	return true;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
}

function parseVersion(version: string): ParsedVersion {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`Invalid rubric version: ${version} (expected X.Y.Z)`);
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}
