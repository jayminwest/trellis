/**
 * Code-quality & hygiene detectors that are language-agnostic (SPEC §5.2, §5.5):
 * `large_file_detection`, `tech_debt_tracking`, `pre_commit_hooks`.
 *
 * All three are non-skippable → present → pass, absent → fail. They look for an
 * enforced budget/ratchet or a committed hook setup (the os-eco L5 toolkit
 * convention), not merely a doc mention, so the signal means "enforced," not
 * "aspired to."
 */
import { type Detector, fail, pass } from "../types.ts";
import { firstHit, globHits, packageScripts, readJson } from "./util.ts";

/** `large_file_detection` (R/L3): an enforced file-size budget/ratchet. */
export const largeFileDetection: Detector = async (ctx) => {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const re = /file.?size|filesize|max.?lines|loc.?budget/i;
	const scriptHit = Object.entries(scripts).find(([k, v]) => re.test(k) || re.test(v));
	if (scriptHit !== undefined)
		return pass(`file-size budget enforced via script '${scriptHit[0]}'`);
	const files = await globHits(ctx, [
		"scripts/*file*size*",
		"scripts/check-file-sizes.*",
		"**/file-size-budget*.json",
		"**/file-size-budgets*.json",
	]);
	if (files.length > 0)
		return pass(`file-size ratchet/budget present: ${files.slice(0, 2).join(", ")}`);
	return fail("no enforced file-size budget (ratchet script or budget file) found");
};

/** `tech_debt_tracking` (R/L3): debt markers inventoried/tracked via a ratchet. */
export const techDebtTracking: Detector = async (ctx) => {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const re = /debt|todo|fixme|marker/i;
	const scriptHit = Object.entries(scripts).find(([k, v]) => re.test(k) || re.test(v));
	if (scriptHit !== undefined) return pass(`debt markers tracked via script '${scriptHit[0]}'`);
	const files = await globHits(ctx, [
		"scripts/*debt*",
		"scripts/check-debt-markers.*",
		"**/debt-markers-budget*.json",
		"**/debt-budget*.json",
	]);
	if (files.length > 0)
		return pass(`debt-marker ratchet/budget present: ${files.slice(0, 2).join(", ")}`);
	return fail("no debt-marker tracking (ratchet script or budget file) found");
};

/** `pre_commit_hooks` (A/L2): a committed pre-commit hook setup. */
export const preCommitHooks: Detector = async (ctx) => {
	const cfg = await firstHit(ctx, [
		".pre-commit-config.yaml",
		".pre-commit-config.yml",
		".husky/pre-commit",
		".githooks/pre-commit",
		"lefthook.yml",
		"lefthook.yaml",
		".lefthook.yml",
	]);
	if (cfg !== null) return pass(`committed pre-commit hook setup: '${cfg}'`);
	const pkg = await readJson(ctx, "package.json");
	const scripts = packageScripts(pkg);
	// A `prepare`/hooks script that wires git's core.hooksPath to a committed dir.
	const hooksPathScript = Object.values(scripts).find((cmd) => /core\.hooksPath/.test(cmd));
	if (hooksPathScript !== undefined) {
		const match = hooksPathScript.match(/core\.hooksPath\s+(\S+)/);
		const dir = match?.[1];
		if (dir !== undefined) {
			const hook = await firstHit(ctx, [`${dir}/pre-commit`, `${dir}/*`]);
			if (hook !== null) return pass(`git core.hooksPath -> committed hook '${hook}'`);
		}
	}
	if (pkg !== null && (pkg.husky !== undefined || pkg["simple-git-hooks"] !== undefined)) {
		return pass("package.json declares a git-hooks manager (husky/simple-git-hooks)");
	}
	return fail("no committed pre-commit hook setup (.pre-commit-config / husky / hooksPath)");
};
