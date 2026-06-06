/**
 * Process & Collaboration detectors (SPEC §5.8) — the deterministic,
 * language-agnostic subset: `codeowners`, `issue_templates`,
 * `issue_labeling_system`, `pr_templates`, `automated_pr_review`,
 * `backlog_health`.
 *
 * The four non-skippable governance files (codeowners, issue/PR templates,
 * labeling) follow the §3.2 floor: present → pass, absent → fail. The two
 * skippable signals (`automated_pr_review`, `backlog_health`) map absence to
 * not-applicable. os-eco-native augmentation (`.seeds/` etc.) lands separately
 * (trellis-7f70); these stay tool-agnostic.
 */
import { type Detector, fail, notApplicable, pass } from "../types.ts";
import { anyWorkflowMatches, firstHit, globHits, readWorkflows } from "./util.ts";

/** CODEOWNERS lookup locations (GitHub/GitLab conventions). */
const CODEOWNERS_PATTERNS = [
	"CODEOWNERS",
	".github/CODEOWNERS",
	"docs/CODEOWNERS",
	".gitlab/CODEOWNERS",
];

/** `codeowners` (R/L2, gate): a non-empty code-ownership map exists. */
export const codeowners: Detector = async (ctx) => {
	const hit = await firstHit(ctx, CODEOWNERS_PATTERNS);
	if (hit === null) return fail("no CODEOWNERS file at any known location");
	const text = (await ctx.readFile(hit)) ?? "";
	const rules = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	return rules.length > 0
		? pass(`CODEOWNERS at '${hit}' with ${rules.length} ownership rule(s)`)
		: fail(`CODEOWNERS at '${hit}' has no ownership rules`);
};

/** `issue_templates` (R/L2): committed issue templates. */
export const issueTemplates: Detector = async (ctx) => {
	const hits = await globHits(ctx, [
		".github/ISSUE_TEMPLATE/*.md",
		".github/ISSUE_TEMPLATE/*.yml",
		".github/ISSUE_TEMPLATE/*.yaml",
		".github/ISSUE_TEMPLATE.md",
		".github/issue_template.md",
		".gitlab/issue_templates/*",
	]);
	return hits.length > 0
		? pass(`${hits.length} issue template(s) committed (e.g. '${hits[0]}')`)
		: fail("no issue templates (.github/ISSUE_TEMPLATE/) committed");
};

/** `issue_labeling_system` (R/L2): a deliberate, version-controlled labeling scheme. */
export const issueLabelingSystem: Detector = async (ctx) => {
	const cfg = await firstHit(ctx, [
		".github/labels.yml",
		".github/labels.yaml",
		".github/labeler.yml",
	]);
	if (cfg !== null) return pass(`labeling scheme committed: '${cfg}'`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(
			workflows,
			/sync-labels|crazy-max\/ghaction-github-labeler|actions\/labeler/i,
		)
	) {
		return pass("a CI workflow syncs a deliberate label set");
	}
	return fail("no committed labeling scheme (.github/labels.yml or a label-sync workflow)");
};

/** `pr_templates` (R/L2): a committed PR/MR template. */
export const prTemplates: Detector = async (ctx) => {
	const hit = await firstHit(ctx, [
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		".github/PULL_REQUEST_TEMPLATE/*.md",
		"docs/pull_request_template.md",
		"PULL_REQUEST_TEMPLATE.md",
		".gitlab/merge_request_templates/*",
	]);
	return hit !== null
		? pass(`PR/MR template committed at '${hit}'`)
		: fail("no committed PR/MR template (.github/pull_request_template.md)");
};

/** `automated_pr_review` (R/L2, S): a bot/workflow first-pass PR review. */
export const automatedPrReview: Detector = async (ctx) => {
	const cfg = await firstHit(ctx, [
		".coderabbit.yaml",
		".coderabbit.yml",
		"dangerfile.js",
		"dangerfile.ts",
		"Dangerfile",
	]);
	if (cfg !== null) return pass(`automated PR-review config present: '${cfg}'`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(workflows, /coderabbit|reviewdog|danger|pull_request_review|review-bot/i)
	) {
		return pass("a CI workflow performs an automated first-pass PR review");
	}
	return notApplicable("no automated PR-review bot/workflow (skippable → N/A)");
};

/** `backlog_health` (R/L4, S): backlog actively groomed (stale-bot/board automation). */
export const backlogHealth: Detector = async (ctx) => {
	const cfg = await firstHit(ctx, [".github/stale.yml", ".github/stale.yaml"]);
	if (cfg !== null) return pass(`backlog grooming automation present: '${cfg}'`);
	const workflows = await readWorkflows(ctx);
	if (
		anyWorkflowMatches(workflows, /actions\/stale|stale-issue|project.*automation|add-to-project/i)
	) {
		return pass("a CI workflow grooms the backlog (stale/board automation)");
	}
	return notApplicable(
		"no backlog-grooming automation (stale bot / project board) (skippable → N/A)",
	);
};
