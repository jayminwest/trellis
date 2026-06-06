/**
 * Read-only helpers for the os-eco-native evidence detectors (SPEC §8.4).
 *
 * Everything goes through the {@link DetectionContext} capabilities only (no
 * direct fs), so these inherit the context's repo-containment and never-throws
 * guarantees. The os-eco surfaces (`.seeds/`, `.mulch/`, `.canopy/`, `.plot/`,
 * nested `SKILL.md`, `package.json` `check:*`/`gen:*` scripts, CI invoking them, and
 * agent co-author trailers in git) are all read relative to the supplied context
 * — the overlay runs them once at the repo root (SPEC §8.4), so app-relative ≡
 * repo-relative there.
 */
import { globHits, packageScripts, readJson, readWorkflows } from "../common/util.ts";
import type { DetectionContext } from "../types.ts";

/** True if directory `dir` exists with at least one (possibly dotted) file under it. */
export async function dirPresent(ctx: DetectionContext, dir: string): Promise<boolean> {
	const hits = await globHits(ctx, [`${dir}/*`, `${dir}/**/*`]);
	return hits.length > 0;
}

/** The first `package.json` script whose name or command matches `re`, or `null`. */
export async function scriptMatching(
	ctx: DetectionContext,
	re: RegExp,
): Promise<{ name: string; cmd: string } | null> {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	for (const [name, cmd] of Object.entries(scripts)) {
		if (re.test(name) || re.test(cmd)) return { name, cmd };
	}
	return null;
}

/** True if any CI workflow's contents match `re` (full-gate parity evidence). */
export async function ciInvokes(ctx: DetectionContext, re: RegExp): Promise<boolean> {
	const workflows = await readWorkflows(ctx);
	return workflows.some((w) => re.test(w.text));
}

/** Markers that identify an automated coding agent in a Co-authored-by trailer / author field. */
const AGENT_MARKER = /\[bot\]|droid|claude|copilot|cursor|devin|sapling|warren|aider|codex/i;

/**
 * True if recent git history carries agent co-authorship (SPEC §8.4) — a
 * `Co-authored-by` trailer or author/committer field naming a known coding
 * agent. Bounded to the last 200 commits; a non-git checkout (exit ≠ 0) yields
 * `false` without throwing.
 */
export async function hasAgentTrailers(ctx: DetectionContext): Promise<boolean> {
	const res = await ctx.run([
		"git",
		"log",
		"-n",
		"200",
		"--pretty=format:%an <%ae>%n%(trailers:key=Co-authored-by,valueonly)",
	]);
	if (res.exitCode !== 0) return false;
	return AGENT_MARKER.test(res.stdout);
}
