/**
 * os-eco-native evidence detectors (SPEC §8.4). Each recognizes an os-eco
 * convention as positive evidence for an **existing** rubric criterion — no new
 * category. They are *not* bound in the registry (that is the deterministic
 * HOW); instead the audit pipeline folds them over the base verdict via the
 * {@link OSECO_OVERLAY} map: pass if either passes, with the evidence path named
 * in the rationale (the composition rule, SPEC §8.4 / §6.5).
 *
 * Each detector returns {@link pass} when its os-eco surface is present, else
 * {@link notApplicable} ("no os-eco evidence") — the overlay treats anything but
 * a pass as "stay with the base verdict," so a missing surface never lowers a
 * score. The whole pack is gated by `ctx.osecoDetectors` upstream; these run
 * only when the toggle is on.
 */
import { firstHit } from "../common/util.ts";
import { type Detector, notApplicable, pass } from "../types.ts";
import { ciInvokes, dirPresent, hasAgentTrailers, scriptMatching } from "./util.ts";

const NONE = (what: string): ReturnType<typeof notApplicable> =>
	notApplicable(`no os-eco ${what} evidence`);

/** `agents_md`: rich agent instructions — `AGENTS.md` (+ `CLAUDE.md`) present. */
export const agentsMd: Detector = async (ctx) => {
	const agents = await firstHit(ctx, ["AGENTS.md"]);
	if (agents === null) return NONE("AGENTS.md");
	const claude = await firstHit(ctx, ["CLAUDE.md"]);
	const both = claude !== null ? " + CLAUDE.md" : "";
	return pass(`os-eco agent docs present: AGENTS.md${both}`);
};

/** `skills`: Factory/Droid-style skills — any nested `SKILL.md`. */
export const skills: Detector = async (ctx) => {
	const hit = await firstHit(ctx, ["**/SKILL.md", "SKILL.md"]);
	return hit === null ? NONE("SKILL.md") : pass(`os-eco skill present: ${hit}`);
};

/** `issue_templates`: a `.seeds/` tracker provides structured issue creation. */
export const seedsIssueTemplates: Detector = async (ctx) => {
	return (await dirPresent(ctx, ".seeds"))
		? pass(".seeds/ tracker present — structured (templated) issue creation via seeds")
		: NONE(".seeds/");
};

/** `issue_labeling_system`: `.seeds/` present + a labeling-capable config. */
export const seedsLabeling: Detector = async (ctx) => {
	if (!(await dirPresent(ctx, ".seeds"))) return NONE(".seeds/");
	const cfg = await firstHit(ctx, [".seeds/config.*", ".seeds/*.toml", ".seeds/*.yaml"]);
	const via = cfg !== null ? ` (config: ${cfg})` : "";
	return pass(`.seeds/ tracker present — seeds label system${via}`);
};

/** `backlog_health`: an active `.seeds/` backlog (issue records present). */
export const seedsBacklog: Detector = async (ctx) => {
	const issues = await firstHit(ctx, [".seeds/issues/**", ".seeds/**/*.json", ".seeds/**/*.md"]);
	return issues === null
		? NONE(".seeds/ backlog")
		: pass(".seeds/ tracker carries an active backlog (sd-managed issue records)");
};

/** `unit_tests_runnable`: a `test`/`check:all` script (bun test under the gate). */
export const checkAllTests: Detector = async (ctx) => {
	const hit = await scriptMatching(ctx, /^(test|test:ci|check:all)$|\bbun test\b/);
	return hit === null
		? NONE("check:all/test")
		: pass(`os-eco runnable test gate via script '${hit.name}'`);
};

/** `pre_commit_hooks`: a `check:all` gate plus a committed hook wiring it. */
export const checkAllPreCommit: Detector = async (ctx) => {
	const gate = await scriptMatching(ctx, /^check:all$|check:all/);
	if (gate === null) return NONE("check:all gate");
	const hook = await firstHit(ctx, [".githooks/pre-commit", ".husky/pre-commit"]);
	return hook === null
		? NONE("committed pre-commit hook")
		: pass(`os-eco check:all gate + committed hook '${hook}'`);
};

/** `fast_ci_feedback`: CI invokes the full `check:all` gate (parity with local). */
export const checkAllCi: Detector = async (ctx) => {
	const gate = await scriptMatching(ctx, /^check:all$|check:all/);
	if (gate === null) return NONE("check:all gate");
	return (await ciInvokes(ctx, /check:all/))
		? pass("os-eco check:all gate run in CI (full-gate parity → fast, single-command feedback)")
		: NONE("CI invoking check:all");
};

/**
 * Build a ratchet-evidence detector for `criterion`: a `package.json` script
 * (name or command matching `re`) or a committed ratchet/budget file under
 * `scripts/` — the os-eco L5 toolkit convention (SPEC §8.4).
 */
function ratchet(label: string, re: RegExp, files: string[]): Detector {
	return async (ctx) => {
		const hit = await scriptMatching(ctx, re);
		if (hit !== null) return pass(`os-eco ${label} ratchet via script '${hit.name}'`);
		const file = await firstHit(ctx, files);
		return file === null
			? NONE(`${label} ratchet`)
			: pass(`os-eco ${label} ratchet file present: ${file}`);
	};
}

/** `large_file_detection`: file-size ratchet (L5 toolkit `check:file-size`). */
export const largeFile = ratchet("file-size", /file.?size|max.?lines|loc.?budget/i, [
	"scripts/check-file-size*",
	"scripts/*file-size*",
	"scripts/file-size-budget*.json",
]);

/** `tech_debt_tracking`: debt-marker ratchet. */
export const techDebt = ratchet("debt-marker", /debt|todo|fixme|marker/i, [
	"scripts/check-debt*",
	"scripts/*debt*",
	"scripts/debt-markers-budget*.json",
]);

/** `code_quality_metrics`: a quality-metrics reporter/ratchet. */
export const codeQualityMetrics = ratchet(
	"quality-metrics",
	/quality.?metric|complexity|check:quality/i,
	["scripts/quality-metrics*", "scripts/*quality*"],
);

/** `dead_code_detection`: knip (dead exports/files). */
export const deadCode = ratchet("dead-code", /knip|dead.?code|check:knip/i, [
	"knip.json",
	"knip.jsonc",
	"knip.config.*",
]);

/** `duplicate_code_detection`: jscpd (copy-paste). */
export const duplicateCode = ratchet("duplicate-code", /jscpd|duplicat|check:jscpd/i, [
	".jscpd.json",
	"jscpd.json",
	".jscpd.config.*",
]);

/** `unused_dependencies_detection`: knip/deptry over the dependency graph. */
export const unusedDeps = ratchet("unused-deps", /knip|deptry|depcheck|unused.?dep/i, [
	"knip.json",
	"knip.jsonc",
	"knip.config.*",
]);

/** `heavy_dependency_detection`: a bundle/size ratchet. */
export const heavyDeps = ratchet("heavy-dep", /bundle|size.?limit|check:bundle/i, [
	"scripts/check-bundle*",
	"scripts/*bundle*",
	".size-limit.*",
	"size-limit.config.*",
]);

/** `api_schema_docs`: a `gen:openapi` script or a committed `docs/openapi.*`. */
export const apiSchemaDocs: Detector = async (ctx) => {
	const script = await scriptMatching(ctx, /gen:openapi|openapi|gen:schema/i);
	if (script !== null) return pass(`os-eco API schema gen via script '${script.name}'`);
	const file = await firstHit(ctx, ["docs/openapi.yaml", "docs/openapi.yml", "docs/openapi.json"]);
	return file === null ? NONE("api schema docs") : pass(`os-eco API schema doc present: ${file}`);
};

/** `automated_doc_generation`: a `gen:docs` script or a `.canopy/` prompt library. */
export const automatedDocGen: Detector = async (ctx) => {
	const script = await scriptMatching(ctx, /gen:docs|gen:doc\b|generate.?docs/i);
	if (script !== null) return pass(`os-eco doc generation via script '${script.name}'`);
	return (await dirPresent(ctx, ".canopy"))
		? pass(".canopy/ versioned prompt library present (automated agent-config/doc generation)")
		: NONE("gen:docs/.canopy/");
};

/** `documentation_freshness`: a `.mulch/` cross-session expertise store. */
export const documentationFreshness: Detector = async (ctx) => {
	return (await dirPresent(ctx, ".mulch"))
		? pass(".mulch/ expertise store present (cross-session, git-tracked documentation freshness)")
		: NONE(".mulch/");
};

/** `agentic_development`: `.mulch/` or `.plot/`, or agent co-authorship in git history. */
export const agenticDevelopment: Detector = async (ctx) => {
	if (await dirPresent(ctx, ".mulch"))
		return pass(".mulch/ expertise store present (agentic development)");
	if (await dirPresent(ctx, ".plot"))
		return pass(".plot/ coordination object present (agentic development)");
	return (await hasAgentTrailers(ctx))
		? pass("agent co-authorship in git history (agentic development)")
		: NONE("agentic-development");
};

/**
 * Criterion id → os-eco evidence detector (SPEC §8.4). The audit pipeline folds
 * each over the base (deterministic or agent) verdict when `osecoDetectors` is
 * on: pass if either passes. Keys are existing criterion ids — both
 * deterministic and agent — never a new criterion.
 */
export const OSECO_OVERLAY: Readonly<Record<string, Detector>> = {
	// agent-discovery criteria (no registry binding; graded from investigation)
	agents_md: agentsMd,
	skills,
	automated_doc_generation: automatedDocGen,
	documentation_freshness: documentationFreshness,
	agentic_development: agenticDevelopment,
	// deterministic criteria (also have a common/language verdict to merge with)
	issue_templates: seedsIssueTemplates,
	issue_labeling_system: seedsLabeling,
	backlog_health: seedsBacklog,
	unit_tests_runnable: checkAllTests,
	pre_commit_hooks: checkAllPreCommit,
	fast_ci_feedback: checkAllCi,
	large_file_detection: largeFile,
	tech_debt_tracking: techDebt,
	code_quality_metrics: codeQualityMetrics,
	dead_code_detection: deadCode,
	duplicate_code_detection: duplicateCode,
	unused_dependencies_detection: unusedDeps,
	heavy_dependency_detection: heavyDeps,
	api_schema_docs: apiSchemaDocs,
};
