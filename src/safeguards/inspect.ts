/**
 * Safeguard inspection orchestrator (SPEC §5.5, trellis-a97d).
 *
 * {@link inspectSafeguards} runs every surface inspector over one shared
 * {@link SafeguardContext} and returns the full safeguard panel: one
 * {@link SafeguardResult} per supported id (always all of them, in fixed id
 * order — `absent` is a stated result, not an omission) plus the broken
 * hook/check reference findings, deterministically sorted.
 *
 * Safeguards are **not** metrics: the results feed §6.3 of the report and
 * contribute nothing to the sloppiness index in either direction. Passing
 * execution is never inferred — the inspection reads configuration only.
 */
import type { Finding, SafeguardResult } from "../contract/index.ts";
import { inspectAgentHooks } from "./agent-hooks.ts";
import { findBrokenScriptReferences, inspectBudgets } from "./budgets.ts";
import { loadSafeguardContext } from "./context.ts";
import { inspectGitHooks } from "./hooks.ts";
import { CHECK_KINDS, inspectCheckScript } from "./scripts.ts";
import type { SurfaceEvidence } from "./types.ts";

/** The safeguard ids always reported, in report order. */
export const SAFEGUARD_IDS = [
	"pre-commit-hook",
	"agent-hooks",
	"lint-script",
	"typecheck-script",
	"test-script",
	"coverage-budget",
	"file-size-budget",
	"duplication-budget",
] as const;

/** The safeguard panel of one audit: results (§6.3) + located findings. */
export interface SafeguardInspection {
	/** One result per {@link SAFEGUARD_IDS} entry, in that order. */
	results: SafeguardResult[];
	/** Broken hook/check references, sorted by (path, line, kind). */
	findings: Finding[];
}

/** Deterministic finding order: path, then start line, then kind, then summary. */
function compareFindings(a: Finding, b: Finding): number {
	return (
		a.path.localeCompare(b.path) ||
		a.range.start.line - b.range.start.line ||
		a.kind.localeCompare(b.kind) ||
		a.summary.localeCompare(b.summary)
	);
}

/**
 * Inspect every supported safeguard surface below `root`. Reads files only —
 * never executes hooks, imports executable configs, or requires Git. Absent
 * surfaces report `absent`; unsupported constructs report `unknown`.
 */
export async function inspectSafeguards(root: string): Promise<SafeguardInspection> {
	const ctx = await loadSafeguardContext(root);
	const gitHooks = await inspectGitHooks(ctx);
	const agentHooks = await inspectAgentHooks(ctx);
	const budgets = await inspectBudgets(ctx);
	const checkScripts = new Map(
		CHECK_KINDS.map(({ kind, id }) => [id, inspectCheckScript(ctx, kind)]),
	);
	const byId = new Map<string, SurfaceEvidence>([
		["pre-commit-hook", gitHooks],
		["agent-hooks", agentHooks],
		...budgets,
		...checkScripts,
	]);
	const results: SafeguardResult[] = [];
	const findings: Finding[] = [];
	for (const id of SAFEGUARD_IDS) {
		const evidence = byId.get(id);
		if (evidence === undefined) continue;
		results.push({
			id,
			evidence: evidence.level,
			locations: evidence.locations,
			...(evidence.notes.length > 0 ? { notes: evidence.notes.join("; ") } : {}),
		});
		findings.push(...evidence.findings);
	}
	findings.push(...(await findBrokenScriptReferences(ctx)));
	findings.sort(compareFindings);
	return { results, findings };
}
