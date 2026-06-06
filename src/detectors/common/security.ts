/**
 * Security & Data detectors (SPEC §5.7) — the repo-scope, language-agnostic
 * subset: `branch_protection`, `automated_security_review`, `secret_scanning`,
 * `min_release_age`, `privacy_compliance`.
 *
 * `branch_protection` is the one §8.1 "via VCS CLI" probe: it derives the
 * platform from the git remote and asks `gh`/`glab`. Honest §3.2 mapping —
 * no remote → not-applicable (nothing to protect); unknown host or missing CLI
 * → no-detector (owed a real check); platform answers cleanly → pass/fail.
 * `min_release_age` is non-skippable (present → pass, absent → fail); the rest
 * are skippable presence checks (present → pass, absent → not-applicable).
 */
import { SPAWN_FAILURE_EXIT } from "../context.ts";
import {
	type DetectionContext,
	type Detector,
	type DetectorResult,
	fail,
	noDetector,
	notApplicable,
	pass,
} from "../types.ts";
import { anyWorkflowMatches, firstHit, globHits, readWorkflows } from "./util.ts";

/** Parsed `owner/repo` plus platform host from a git remote URL. */
interface Remote {
	host: "github" | "gitlab" | "other";
	slug: string;
}

/** Parse owner/repo and platform from an https or scp-style git remote URL. */
export function parseRemote(url: string): Remote | null {
	const trimmed = url.trim().replace(/\.git$/, "");
	if (trimmed.length === 0) return null;
	// git@host:owner/repo  OR  https://host/owner/repo  OR  ssh://git@host/owner/repo
	const match = trimmed.match(/(?:@|:\/\/)([^/:]+)[/:](.+)$/);
	if (match?.[1] === undefined || match[2] === undefined) return null;
	const hostName = match[1].toLowerCase();
	const slug = match[2].replace(/^\/+/, "");
	if (slug.split("/").length < 2) return null;
	const host = hostName.includes("github")
		? "github"
		: hostName.includes("gitlab")
			? "gitlab"
			: "other";
	return { host, slug };
}

/** Probe GitHub branch-protection rulesets via `gh`. */
async function probeGithub(ctx: DetectionContext, slug: string): Promise<DetectorResult> {
	const probe = await ctx.run(["gh", "api", `repos/${slug}/rulesets`, "--jq", "length"]);
	if (probe.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector("gh CLI not on PATH; cannot probe branch protection");
	}
	if (probe.exitCode !== 0) {
		return noDetector(`gh could not read rulesets for ${slug} (auth/permissions?)`);
	}
	return Number(probe.stdout.trim()) > 0
		? pass(`GitHub repo ${slug} has ${probe.stdout.trim()} ruleset(s)`)
		: fail(`GitHub repo ${slug} has no branch-protection rulesets`);
}

/** Probe GitLab protected branches via `glab`. */
async function probeGitlab(ctx: DetectionContext, slug: string): Promise<DetectorResult> {
	const probe = await ctx.run([
		"glab",
		"api",
		`projects/${encodeURIComponent(slug)}/protected_branches`,
	]);
	if (probe.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector("glab CLI not on PATH; cannot probe branch protection");
	}
	if (probe.exitCode !== 0) {
		return noDetector(`glab could not read protected branches for ${slug}`);
	}
	const body = probe.stdout.trim();
	return body !== "[]" && body.length > 0
		? pass(`GitLab project ${slug} has protected branches`)
		: fail(`GitLab project ${slug} has no protected branches`);
}

/** `branch_protection` (R/L2, S): branch-protection/ruleset via the VCS CLI. */
export const branchProtection: Detector = async (ctx) => {
	const remote = await ctx.run(["git", "remote", "get-url", "origin"]);
	if (remote.exitCode !== 0 || remote.stdout.trim().length === 0) {
		return notApplicable(
			"no 'origin' git remote; no hosting platform to protect (skippable → N/A)",
		);
	}
	const parsed = parseRemote(remote.stdout);
	if (parsed === null) return noDetector(`could not parse git remote '${remote.stdout.trim()}'`);
	if (parsed.host === "github") return probeGithub(ctx, parsed.slug);
	if (parsed.host === "gitlab") return probeGitlab(ctx, parsed.slug);
	return noDetector(`unsupported VCS host for remote ${parsed.slug}; no CLI probe available`);
};

/** `automated_security_review` (R/L2, S): SAST/dependency-audit in CI. */
export const automatedSecurityReview: Detector = async (ctx) => {
	const named = await globHits(ctx, [
		".github/workflows/codeql.yml",
		".github/workflows/codeql.yaml",
	]);
	if (named.length > 0) return pass(`CodeQL workflow present: ${named.join(", ")}`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(
			workflows,
			/codeql|snyk|semgrep|trivy|dependency-review-action|npm audit|bun audit|pnpm audit|pip-audit|cargo audit|osv-scanner/i,
		)
	) {
		return pass("a CI workflow runs SAST/dependency-audit");
	}
	return notApplicable("no SAST/dependency-audit in CI (skippable → N/A)");
};

/** `secret_scanning` (R/L3, S): secret scanning in CI or pre-commit. */
export const secretScanning: Detector = async (ctx) => {
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(workflows, /gitleaks|trufflehog|detect-secrets|ggshield|secret[- ]?scan/i)
	) {
		return pass("a CI workflow runs secret scanning");
	}
	const preCommit = await ctx.readFile(".pre-commit-config.yaml");
	if (preCommit !== null && /gitleaks|detect-secrets|trufflehog/i.test(preCommit)) {
		return pass("pre-commit config runs secret scanning");
	}
	const cfg = await firstHit(ctx, [".gitleaks.toml", "gitleaks.toml", ".secrets.baseline"]);
	if (cfg !== null) return pass(`secret-scanning config present: '${cfg}'`);
	return notApplicable("no secret-scanning in CI/pre-commit (skippable → N/A)");
};

/** `min_release_age` (R/L3): a dependency release-age delay gate. */
export const minReleaseAge: Detector = async (ctx) => {
	const dependabot =
		(await ctx.readFile(".github/dependabot.yml")) ??
		(await ctx.readFile(".github/dependabot.yaml"));
	if (dependabot !== null && /\bcooldown\b/.test(dependabot)) {
		return pass("Dependabot config declares a `cooldown` release-age delay");
	}
	for (const rel of [
		"renovate.json",
		"renovate.json5",
		".renovaterc",
		".renovaterc.json",
		".github/renovate.json",
	]) {
		const text = await ctx.readFile(rel);
		if (text !== null && /minimumReleaseAge|stabilityDays/.test(text)) {
			return pass(`Renovate config '${rel}' sets a minimum release age`);
		}
	}
	return fail(
		"no dependency release-age delay (Dependabot `cooldown` / Renovate `minimumReleaseAge`)",
	);
};

/** `privacy_compliance` (R/L4, S): consent/retention/DSR/anonymization evidence. */
export const privacyCompliance: Detector = async (ctx) => {
	const docs = await globHits(ctx, [
		"PRIVACY.md",
		"docs/PRIVACY.md",
		"docs/privacy*.md",
		"docs/data-retention*.md",
		"docs/gdpr*.md",
	]);
	if (docs.length > 0)
		return pass(`privacy/compliance docs present: ${docs.slice(0, 3).join(", ")}`);
	const scripts = await globHits(ctx, [
		"scripts/*anonymi*",
		"scripts/*retention*",
		"scripts/*gdpr*",
	]);
	if (scripts.length > 0) return pass(`privacy tooling present: ${scripts.slice(0, 3).join(", ")}`);
	return notApplicable("no consent/retention/DSR/anonymization evidence (skippable → N/A)");
};
