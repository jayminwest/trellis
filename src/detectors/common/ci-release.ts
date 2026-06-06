/**
 * CI, Release & Deployment detectors (SPEC §5.5) — all language-agnostic.
 *
 * §3.2 discipline applied uniformly:
 *  - **non-skippable** (`vcs_cli_tools`, `dependency_update_automation`,
 *    `release_notes_automation`, `release_automation`,
 *    `feature_flag_infrastructure`): present → pass, absent → fail.
 *  - **skippable** presence-checkable infra (`monorepo_tooling`,
 *    `version_drift_detection`, `dead_feature_flag_detection`,
 *    `build_performance_tracking`, `progressive_rollout`,
 *    `rollback_automation`): present → pass, surface genuinely absent →
 *    not-applicable (excluded from coverage).
 *  - **skippable** signals that need *run history* the static layer lacks
 *    (`fast_ci_feedback`, `deployment_frequency`): a deliberate static bound →
 *    pass; surface present but unmeasurable here → no-detector (owed a real
 *    check, drags coverage); no surface → not-applicable.
 */
import { SPAWN_FAILURE_EXIT } from "../context.ts";
import { type Detector, fail, noDetector, notApplicable, pass } from "../types.ts";
import {
	anyWorkflowMatches,
	firstHit,
	globHits,
	packageDeps,
	packageScripts,
	readJson,
	readWorkflows,
} from "./util.ts";

/** Workspace/monorepo config files that mark deliberate multi-package tooling. */
const WORKSPACE_FILES = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "go.work"];

/** Bot/scheduled dependency-update config locations. */
const DEP_UPDATE_PATTERNS = [
	".github/dependabot.yml",
	".github/dependabot.yaml",
	"renovate.json",
	"renovate.json5",
	".renovaterc",
	".renovaterc.json",
	".github/renovate.json",
	".gitlab/renovate.json",
];

/** Feature-flag SDKs/services recognized via dependency manifests. */
const FLAG_DEPS = [
	"launchdarkly-node-server-sdk",
	"@launchdarkly/node-server-sdk",
	"unleash-client",
	"flagsmith",
	"flagsmith-nodejs",
	"@openfeature/server-sdk",
	"@openfeature/js-sdk",
	"@flipt-io/flipt",
	"@growthbook/growthbook",
	"@splitsoftware/splitio",
];

/** `vcs_cli_tools` (R/L2, gate): an authenticated `gh`/`glab` is available. */
export const vcsCliTools: Detector = async (ctx) => {
	const gh = await ctx.run(["gh", "auth", "status"]);
	if (gh.exitCode === 0) return pass("gh CLI present and authenticated (gh auth status)");
	const glab = await ctx.run(["glab", "auth", "status"]);
	if (glab.exitCode === 0) return pass("glab CLI present and authenticated (glab auth status)");
	if (gh.exitCode === SPAWN_FAILURE_EXIT && glab.exitCode === SPAWN_FAILURE_EXIT) {
		return fail("no VCS-platform CLI on PATH (neither gh nor glab found)");
	}
	return fail("a VCS-platform CLI is installed but not authenticated (gh/glab auth status failed)");
};

/** `monorepo_tooling` (R/L2, S): workspace/monorepo config present. */
export const monorepoTooling: Detector = async (ctx) => {
	const hit = await firstHit(ctx, WORKSPACE_FILES);
	if (hit !== null) return pass(`workspace config present: '${hit}'`);
	const pkg = await readJson(ctx, "package.json");
	if (pkg !== null && pkg.workspaces !== undefined) return pass("package.json declares workspaces");
	const cargo = await ctx.readFile("Cargo.toml");
	if (cargo !== null && /^\s*\[workspace\]/m.test(cargo))
		return pass("Cargo.toml [workspace] present");
	return notApplicable("no workspace/monorepo config; single-package repo (skippable → N/A)");
};

/** `dependency_update_automation` (R/L2): dependabot/renovate config committed. */
export const dependencyUpdateAutomation: Detector = async (ctx) => {
	const hit = await firstHit(ctx, DEP_UPDATE_PATTERNS);
	return hit !== null
		? pass(`dependency-update bot configured: '${hit}'`)
		: fail("no Dependabot/Renovate config (.github/dependabot.yml, renovate.json) found");
};

/** `release_notes_automation` (R/L3): changelog/release-notes generation tooling. */
export const releaseNotesAutomation: Detector = async (ctx) => {
	const configs = await globHits(ctx, [
		".changeset/config.json",
		"release-please-config.json",
		".release-please-manifest.json",
		".releaserc",
		".releaserc.json",
		".releaserc.yaml",
		".releaserc.yml",
		"release.config.js",
		"release.config.mjs",
	]);
	if (configs.length > 0) return pass(`release-notes tooling config: ${configs.join(", ")}`);
	const deps = packageDeps(await readJson(ctx, "package.json"));
	const depHit = [...deps].find(
		(d) =>
			d === "semantic-release" || d === "@changesets/cli" || d.startsWith("conventional-changelog"),
	);
	if (depHit !== undefined) return pass(`release-notes generator dependency: '${depHit}'`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(
			workflows,
			/changelog|release[- ]?notes|release-please|semantic-release|changeset/i,
		)
	) {
		return pass("a CI workflow generates changelog/release notes");
	}
	return fail("no changelog/release-notes automation (changesets/semantic-release/release-please)");
};

/** `release_automation` (R/L3): an automated release/publish/deploy pipeline. */
export const releaseAutomation: Detector = async (ctx) => {
	const named = await globHits(ctx, [
		".github/workflows/publish.yml",
		".github/workflows/publish.yaml",
		".github/workflows/release.yml",
		".github/workflows/release.yaml",
		".github/workflows/deploy.yml",
		".github/workflows/deploy.yaml",
	]);
	if (named.length > 0) return pass(`release/deploy workflow present: ${named.join(", ")}`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(
			workflows,
			/npm publish|bun publish|pnpm publish|yarn publish|gh release|action-gh-release|cargo publish|twine upload|pypi|on:\s+release|release:\s*\n/i,
		)
	) {
		return pass("a CI workflow runs an automated release/publish step");
	}
	return fail("no automated release/deploy pipeline found in CI workflows");
};

/** `version_drift_detection` (R/L3, S): cross-package version-sync tooling. */
export const versionDriftDetection: Detector = async (ctx) => {
	const configs = await globHits(ctx, [
		".changeset/config.json",
		".syncpackrc",
		".syncpackrc.json",
		"syncpack.config.js",
	]);
	if (configs.length > 0) return pass(`version-sync tooling config: ${configs.join(", ")}`);
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const scriptHit = Object.keys(scripts).find((k) =>
		/version.*(sync|drift|check)|syncpack/i.test(k),
	);
	if (scriptHit !== undefined) return pass(`version-sync script: '${scriptHit}'`);
	return notApplicable(
		"no cross-package version-sync tooling; single-version repo (skippable → N/A)",
	);
};

/** `dead_feature_flag_detection` (R/L3, S): stale-flag detection tooling. */
export const deadFeatureFlagDetection: Detector = async (ctx) => {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const scriptHit = Object.keys(scripts).find((k) =>
		/(dead|stale).*flag|flag.*(lint|cleanup|audit)/i.test(k),
	);
	if (scriptHit !== undefined) return pass(`stale-flag detection script: '${scriptHit}'`);
	const configs = await globHits(ctx, [".unleash/*", "piranha.properties", ".piranha.yml"]);
	if (configs.length > 0) return pass(`stale-flag tooling config: ${configs.join(", ")}`);
	return notApplicable("no stale feature-flag detection tooling (skippable → N/A)");
};

/** `feature_flag_infrastructure` (R/L4): a feature-flag system is configured. */
export const featureFlagInfrastructure: Detector = async (ctx) => {
	const deps = packageDeps(await readJson(ctx, "package.json"));
	const depHit = FLAG_DEPS.find((d) => deps.has(d));
	if (depHit !== undefined) return pass(`feature-flag SDK dependency: '${depHit}'`);
	const configs = await globHits(ctx, [
		"flipt.yml",
		"flipt.yaml",
		"unleash*.json",
		"growthbook.json",
	]);
	if (configs.length > 0) return pass(`feature-flag config: ${configs.join(", ")}`);
	return fail("no feature-flag system (LaunchDarkly/Unleash/OpenFeature/Flipt/…) configured");
};

/** `fast_ci_feedback` (R/L4, S): a deliberate CI time bound; else needs run history. */
export const fastCiFeedback: Detector = async (ctx) => {
	const workflows = await readWorkflows(ctx);
	if (workflows.length === 0)
		return notApplicable("no CI workflows; nothing to time (skippable → N/A)");
	for (const w of workflows) {
		const match = w.text.match(/timeout-minutes:\s*(\d+)/);
		if (match?.[1] !== undefined && Number(match[1]) <= 10) {
			return pass(
				`CI declares a fast-feedback bound (timeout-minutes: ${match[1]} <= 10) in '${w.path}'`,
			);
		}
	}
	return noDetector(
		"CI present but actual wall-time needs run history (§11), unavailable to the static detector",
	);
};

/** `build_performance_tracking` (R/L4, S): build timing/caching/metrics tooling. */
export const buildPerformanceTracking: Detector = async (ctx) => {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const scriptHit = Object.keys(scripts).find((k) =>
		/report.*(timing|metrics|perf)|build.*(timing|perf)/i.test(k),
	);
	if (scriptHit !== undefined) return pass(`build/perf tracking script: '${scriptHit}'`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(workflows, /actions\/cache|cache:\s|setup-[a-z]+@.*\n?.*cache|turbo.*cache/i)
	) {
		return pass("a CI workflow uses build caching/perf tracking");
	}
	return notApplicable("no build timing/caching/metrics tooling (skippable → N/A)");
};

/** `deployment_frequency` (R/L4, S): ships often — needs deploy history. */
export const deploymentFrequency: Detector = async (ctx) => {
	const workflows = await readWorkflows(ctx);
	const hasDeploy =
		(await firstHit(ctx, [".github/workflows/deploy.yml", ".github/workflows/deploy.yaml"])) !==
			null ||
		anyWorkflowMatches(workflows, /deploy|cloud run|vercel|fly deploy|kubectl|helm upgrade/i);
	return hasDeploy
		? noDetector(
				"deploy automation present but cadence needs deploy history (§11), unavailable here",
			)
		: notApplicable("no continuous-deployment pipeline; cadence N/A (skippable → N/A)");
};

/** `progressive_rollout` (R/L4, S): canary/percentage/ring deploy config. */
export const progressiveRollout: Detector = async (ctx) => {
	const configs = await globHits(ctx, [
		"**/Rollout.yaml",
		"**/rollout.yaml",
		".flagger/*",
		"**/canary.yaml",
	]);
	if (configs.length > 0)
		return pass(`progressive-rollout config: ${configs.slice(0, 3).join(", ")}`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(
			workflows,
			/canary|argo[- ]?rollout|flagger|blue[- ]?green|percentage rollout/i,
		)
	) {
		return pass("a CI workflow drives a canary/progressive rollout");
	}
	return notApplicable("no canary/percentage/ring rollout config (skippable → N/A)");
};

/** `rollback_automation` (R/L4, S): a scripted/automated rollback path. */
export const rollbackAutomation: Detector = async (ctx) => {
	const named = await globHits(ctx, [
		".github/workflows/rollback.yml",
		".github/workflows/rollback.yaml",
	]);
	if (named.length > 0) return pass(`rollback workflow present: ${named.join(", ")}`);
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const scriptHit = Object.keys(scripts).find((k) => /rollback|revert.*deploy/i.test(k));
	if (scriptHit !== undefined) return pass(`rollback script: '${scriptHit}'`);
	const workflows = await readWorkflows(ctx);
	if (anyWorkflowMatches(workflows, /rollback|rollout undo|vercel rollback|helm rollback/i)) {
		return pass("a CI workflow provides an automated rollback");
	}
	return notApplicable("no automated rollback path (workflow/script) found (skippable → N/A)");
};
