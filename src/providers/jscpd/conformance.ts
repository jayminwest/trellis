/**
 * Shared corpus, fixtures, and staged-run harness for the jscpd
 * conformance suites (plan `pl-43c5` — trellis-b0ec, step 14: the jscpd
 * provider passes bounded conformance and failure regressions).
 *
 * The conformance corpus is **authored, bounded, and generated at test
 * time**: the five labeled research controls (identical copy, renamed
 * copy, edited copy, unrelated pair, ambiguous idiomatic pair) come from
 * the spike's checked-in `fixtures.json` — one text each, so no clone
 * fixture is ever checked in as two source files — and the additional
 * input surfaces (TSX with template/regex literals, malformed syntax) are
 * authored here as single texts. Pairs exist only inside throwaway temp
 * workspaces. The record of what this corpus proves — expected evidence,
 * the failure matrix, repeat/runtime/memory observations, and the
 * retained leads — is [`docs/jscpd-conformance.md`](../../../docs/jscpd-conformance.md).
 *
 * Every real-binary run goes through the delivered boundaries and nothing
 * else: the pinned-tool resolver (`../resolve.ts`), the controlled process
 * runner (`../process.ts`), and a staged source view (`../workspace.ts`)
 * — never a direct jscpd invocation, never the target workspace, offline,
 * with trellis-owned scratch cleaned on every exit path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CLONE_MATCH_MODES,
	type CloneGroupEvidence,
	type CloneLocation,
	type CloneMatchMode,
	type ClonePair,
} from "../../contract/index.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import { type JscpdAdapterResult, type JscpdRequest, runJscpdAdapter } from "./adapter.ts";
import type { JscpdModeOutcome } from "./mode-run.ts";
import { fixtureTexts, TOTAL_FUNCTION } from "./normalize.fixtures.ts";
import { type JscpdNormalizedEvidence, normalizeJscpdReport } from "./normalize.ts";

/**
 * Authored TSX control: a component using template literals and a regex
 * literal (above the 50-token threshold), staged twice at test time.
 */
export const TSX_COMPONENT = `export function Badge({ label, count }: { label: string; count: number }) {
 const pattern = /^[a-z][a-z0-9-]*$/;
 const normalized = pattern.test(label) ? label : label.replaceAll(" ", "-").toLowerCase();
 const title = \`\${normalized} [\${count}]\`;
 const aria = \`badge \${count} of \${normalized}\`;
 return { className: "badge badge-" + normalized, title, ariaLabel: aria, count };
}
`;

/**
 * Authored malformed control: above the token threshold (the pinned tool
 * reports 91 tokens) but syntactically broken — a missing parameter comma
 * and an extra brace — for exercising parser lenience without grammar.
 */
export const BROKEN_FUNCTION = TOTAL_FUNCTION.replace(
	"(items: number[], limit: number): number {",
	"(items: number[] limit: number): number { {",
);

/** The labeled fixture texts of one research control (fails fast on an unknown case). */
export { fixtureTexts };

/** One control's files under `controls/<case>-<name>` paths (stable corpus order). */
function controlFiles(caseName: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(fixtureTexts(caseName)).map(([name, text]) => [
			`controls/${caseName}-${name}`,
			text,
		]),
	);
}

/** The bounded conformance corpus: the five controls plus the TSX pair (12 files). */
export const CONFORMANCE_CORPUS: Readonly<Record<string, string>> = {
	...controlFiles("exact"),
	...controlFiles("renamed"),
	...controlFiles("near"),
	...controlFiles("unrelated"),
	...controlFiles("idiom"),
	"tsx/a.tsx": TSX_COMPONENT,
	"tsx/b.tsx": TSX_COMPONENT,
};

/** Production selection entries for the given repo-relative paths. */
export function productionSelection(paths: readonly string[]): StagedSelectionFile[] {
	return paths.map((path) => ({ path, sourceSet: "production" as const, packagePath: "." }));
}

/**
 * Stage a fresh no-dependency, non-Git conformance workspace holding exactly
 * `files` (plus anything the caller stages from them), run `run` with the
 * view and root, and clean both on every exit path.
 */
export async function withConformanceWorkspace<T>(
	files: Record<string, string>,
	run: (view: StagedWorkspaceView, root: string) => Promise<T>,
	selection?: readonly StagedSelectionFile[],
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-conformance-"));
	for (const [path, source] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	const view = await stageWorkspaceView({
		root,
		files: selection ?? productionSelection(Object.keys(files)),
	});
	try {
		return await run(view, root);
	} finally {
		await view.cleanup();
		await rm(root, { recursive: true, force: true });
	}
}

/** One conformance adapter run over a fresh staged workspace. */
export interface ConformanceRun {
	adapter: JscpdAdapterResult;
	/** The outcome of one requested mode (fails fast when it was not requested). */
	outcomeOf(mode: CloneMatchMode): JscpdModeOutcome;
	/** The normalized evidence of one mode, when its outcome carried a raw report. */
	normalizedOf(mode: CloneMatchMode): JscpdNormalizedEvidence | undefined;
}

/** The accounted files of a staged view against its authored texts. */
function accountedFilesOf(view: StagedWorkspaceView, files: Record<string, string>) {
	return view.files.map((file) => {
		const text = files[file.path];
		if (text === undefined) {
			throw new Error(`staged file "${file.path}" has no authored text`);
		}
		if (file.sourceSet !== "production" && file.sourceSet !== "test") {
			throw new Error(`staged file "${file.path}" is not in the measured production/test sets`);
		}
		return { path: file.path, sourceSet: file.sourceSet, text };
	});
}

/**
 * Run the adapter over a fresh staged workspace of `files` (all three modes
 * unless the request narrows them) and expose per-mode outcomes and
 * normalized evidence over the same staged selection.
 */
export async function runConformanceAdapter(
	files: Record<string, string>,
	request: JscpdRequest = {},
	selection?: readonly StagedSelectionFile[],
): Promise<ConformanceRun> {
	return withConformanceWorkspace(
		files,
		async (view) => {
			const adapter = await runJscpdAdapter(view, {
				modes: [...CLONE_MATCH_MODES],
				...request,
			});
			const accounted = accountedFilesOf(view, files);
			const byMode = new Map(adapter.outcomes.map((outcome) => [outcome.mode, outcome]));
			return {
				adapter,
				outcomeOf(mode: CloneMatchMode): JscpdModeOutcome {
					const outcome = byMode.get(mode);
					if (outcome === undefined) {
						throw new Error(`mode "${mode}" was not requested`);
					}
					return outcome;
				},
				normalizedOf(mode: CloneMatchMode): JscpdNormalizedEvidence | undefined {
					const outcome = byMode.get(mode);
					if (outcome === undefined || !("report" in outcome) || outcome.report === undefined) {
						return undefined;
					}
					return normalizeJscpdReport(outcome.report, accounted);
				},
			};
		},
		selection,
	);
}

/** Narrow one mode outcome to its complete variant (the expect already failed otherwise). */
export function requireComplete(
	run: ConformanceRun,
	mode: CloneMatchMode,
): Extract<JscpdModeOutcome, { state: "complete" }> {
	const outcome = run.outcomeOf(mode);
	if (outcome.state !== "complete") {
		throw new Error(`expected the "${mode}" mode to complete, got "${outcome.state}"`);
	}
	return outcome;
}

/** Narrow one mode outcome to its incomplete variant (the expect already failed otherwise). */
export function requireIncomplete(
	run: ConformanceRun,
	mode: CloneMatchMode,
): Extract<JscpdModeOutcome, { state: "incomplete" }> {
	const outcome = run.outcomeOf(mode);
	if (outcome.state !== "incomplete") {
		throw new Error(`expected the "${mode}" mode to be incomplete, got "${outcome.state}"`);
	}
	return outcome;
}

/** A contract clone location over reported whole lines (columns 1-based). */
export function locationOf(
	path: string,
	startLine: number,
	endLine: number,
	startColumn = 1,
	endColumn = 2,
): CloneLocation {
	return {
		path,
		range: {
			start: { line: startLine, column: startColumn },
			end: { line: endLine, column: endColumn },
		},
	};
}

/** The expected pair evidence for two member locations. */
export function pairEvidence(
	matchMode: CloneMatchMode,
	first: CloneLocation,
	second: CloneLocation,
): ClonePair {
	return { kind: "pair", matchMode, members: [first, second] };
}

/** The expected group evidence over member locations (never a `near` group). */
export function groupEvidence(
	matchMode: Extract<CloneMatchMode, "exact" | "normalized">,
	members: readonly CloneLocation[],
): CloneGroupEvidence {
	return { kind: "group", matchMode, members: [...members] };
}

/** One expected source-set line account. */
export function lineAccount(files: number, codeLines: number, affectedCodeLines: number) {
	return { files, codeLines, affectedCodeLines };
}
