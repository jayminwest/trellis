/**
 * Enforcement-point wiring (SPEC §5.5, trellis-a97d).
 *
 * A safeguard is `structurally-wired` only when its configuration is
 * verifiably connected to an enforcement point — a CI `run:` step invoking
 * the check, or a manifest script chain reachable from one through
 * documented `run` references. Executable runners (`bun scripts/check-all.ts`)
 * are opaque: the chain stops at them and their internal behavior stays
 * unverified, so a check reachable *only* through a runner is `configured`,
 * never wired.
 */
import type { Finding } from "../contract/index.ts";
import { type CheckKind, extractRunReferences, recognizeCheck } from "./shell.ts";
import type { SafeguardContext, ScriptEntry } from "./types.ts";

/** The finding kind for broken hook/check references (SPEC §5.5). */
export const BROKEN_REFERENCE_KIND = "safeguard.broken-reference";

/** How one script was reached from CI (for the evidence note). */
export interface Reach {
	/** The workflow path that anchors the chain. */
	workflow: string;
	/** The script names from the CI-referenced script to this one (empty when direct). */
	chain: string[];
}

/**
 * Scripts reachable from CI `run:` steps via documented `run` references,
 * with the first discovered reach path per script. Direct references seed the
 * set; transitive references follow script bodies. Unbounded chains are
 * cycle-safe (each script is visited once).
 */
export function ciReachableScripts(ctx: SafeguardContext): Map<string, Reach> {
	const byName = new Map<string, ScriptEntry>();
	for (const script of ctx.manifest?.scripts ?? []) byName.set(script.name, script);
	const reach = new Map<string, Reach>();
	const queue: string[] = [];
	const visit = (name: string, via: Reach): void => {
		if (!byName.has(name) || reach.has(name)) return;
		reach.set(name, via);
		queue.push(name);
	};
	for (const workflow of ctx.workflows) {
		for (const command of workflow.commands) {
			for (const name of extractRunReferences(command.text)) {
				visit(name, { workflow: workflow.path, chain: [] });
			}
		}
	}
	for (let head = 0; head < queue.length; head++) {
		const current = queue[head] ?? "";
		const via = reach.get(current);
		if (via === undefined) continue;
		for (const next of extractRunReferences(byName.get(current)?.body ?? "")) {
			visit(next, { workflow: via.workflow, chain: [...via.chain, current] });
		}
	}
	return reach;
}

/** Check kinds invoked **directly** by CI `run:` commands (e.g. a bare `bun test` step). */
export function ciDirectChecks(ctx: SafeguardContext): Set<CheckKind> {
	const kinds = new Set<CheckKind>();
	for (const workflow of ctx.workflows) {
		for (const command of workflow.commands) {
			const kind = recognizeCheck(command.text);
			if (kind !== null) kinds.add(kind);
		}
	}
	return kinds;
}

/** Describe a reach chain for a note (`ci.yml: ci → check:all → lint`). */
export function describeReach(script: string, reach: Reach): string {
	const chain = [...reach.chain, script].join(" → ");
	return `${reach.workflow}: ${chain}`;
}

/**
 * Broken-reference findings for repo-local paths named in `command` that do
 * not exist below the root. `origin` locates the reference (path + 1-based
 * line); the summary names the missing target. Deterministic input order is
 * preserved; the caller sorts findings globally.
 */
export async function brokenPathFindings(
	ctx: SafeguardContext,
	origin: { path: string; line: number },
	command: string,
	referencedBy: string,
	localPaths: readonly string[],
): Promise<Finding[]> {
	const findings: Finding[] = [];
	for (const rel of localPaths) {
		if (await ctx.pathExists(rel)) continue;
		findings.push({
			kind: BROKEN_REFERENCE_KIND,
			path: origin.path,
			range: { start: { line: origin.line }, end: { line: origin.line } },
			summary: `${referencedBy} references '${rel}', which does not exist`,
			facts: { reference: rel, source: command },
		});
	}
	return findings;
}
