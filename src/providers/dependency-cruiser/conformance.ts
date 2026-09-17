/**
 * Shared fixture workspace and staged-run harness for the
 * dependency-cruiser conformance suite (plan `pl-43c5` step 22 —
 * trellis-adbf, acceptance 2–5).
 *
 * The corpus is **authored and generated at test time**: a small labeled
 * architecture workspace (mirroring the research spike's controls —
 * docs/research/architecture-provider-spike) holding every positive case
 * and negative control the adapter must distinguish — a forbidden
 * boundary, a runtime cycle, a type-only cycle, an allowed-import
 * exemption, an unresolved local import, a literal dynamic import, an
 * external import and a builtin import — plus the declarative rule set
 * that governs them. Pairs and workspaces exist only inside throwaway
 * temp directories; every real-binary run goes through the delivered
 * boundaries and nothing else: the pinned-tool resolver
 * (`../resolve.ts`), the controlled process runner (`../process.ts`)
 * and a staged source view (`../workspace.ts`) — never a direct
 * dependency-cruiser invocation, never the target workspace, offline,
 * with trellis-owned scratch cleaned on every exit path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DependencyCruiserProviderRequest } from "../../contract/index.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import type { DependencyCruiserAdapterResult } from "./adapter.ts";
import { runDependencyCruiserAdapter } from "./adapter.ts";
import type { DependencyCruiserNormalizedEvidence } from "./normalize.ts";
import { normalizeDependencyCruiserReport } from "./normalize.ts";
import { compileArchitecturePolicy } from "./policy.ts";

/**
 * The authored architecture fixture: every module below is one file under
 * `src/` (repo-relative), with its exact content — the labeled positive
 * cases and negative controls the conformance suite asserts.
 */
export const ARCHITECTURE_FIXTURE: Readonly<Record<string, string>> = {
	"src/main.ts":
		'import { used } from "./live.ts";\n' +
		'import { first } from "./cycle-a.ts";\n' +
		'import "./domain/bad.ts";\n' +
		'import "./domain/good.ts";\n' +
		'import "./missing.ts";\n' +
		'import type { A } from "./type-a.ts";\n' +
		'import { z } from "zod";\n' +
		"export const publicApi = (x: A) => [used, first, x, z];\n" +
		'export const lazy = () => import("./lazy.ts");\n',
	"src/live.ts":
		'import { readFileSync } from "node:fs";\nexport const used = 1;\nexport const read = () => readFileSync;\n',
	"src/dead.ts": "export const orphan = 0;\n",
	"src/lazy.ts": "export const lazyValue = 3;\n",
	"src/cycle-a.ts":
		'import { second } from "./cycle-b.ts";\nexport const first = () => second();\n',
	"src/cycle-b.ts": 'import { first } from "./cycle-a.ts";\nexport const second = () => first;\n',
	"src/domain/bad.ts": 'import { view } from "../ui/view.ts";\nexport const bad = view;\n',
	"src/domain/good.ts": 'import { util } from "../shared/util.ts";\nexport const good = util;\n',
	"src/ui/view.ts": "export const view = 1;\n",
	"src/shared/util.ts": "export const util = 2;\n",
	"src/type-a.ts": 'import type { B } from "./type-b.ts";\nexport interface A { b?: B }\n',
	"src/type-b.ts": 'import type { A } from "./type-a.ts";\nexport interface B { a?: A }\n',
};

/**
 * The conformance rule set: the declarative subset the fixture exercises —
 * boundary (forbidden, with an allowed exception and an allowed negative
 * control), cycle (runtime and type-only kept distinct), and unresolved
 * (local specifiers only; externals are preserved stubs, never violations).
 */
export const ARCHITECTURE_REQUEST: DependencyCruiserProviderRequest = {
	rules: [
		{ kind: "cycle", name: "no-runtime-cycles", edges: ["runtime"] },
		{ kind: "cycle", name: "no-type-only-cycles", edges: ["type-only"] },
		{
			kind: "boundary",
			name: "domain-must-not-import-ui",
			allowance: "forbidden",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: "^src/ui/" },
		},
		{
			kind: "boundary",
			name: "allow-domain-shared",
			allowance: "allowed",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: "^src/shared/" },
		},
		{
			kind: "boundary",
			name: "allow-bad-view",
			allowance: "allowed",
			edges: ["runtime"],
			from: { path: "^src/domain/bad\\.ts$" },
			to: { path: "^src/ui/view\\.ts$" },
		},
		{ kind: "unresolved", name: "no-unresolved-imports" },
	],
};

/** Production selection entries for the given repo-relative paths. */
export function productionSelection(paths: readonly string[]): StagedSelectionFile[] {
	return paths.map((path) => ({ path, sourceSet: "production" as const, packagePath: "." }));
}

/**
 * Stage a fresh no-dependency, non-Git conformance workspace holding
 * exactly `files`, run `run` with the staged view and the workspace root,
 * and clean both on every exit path.
 */
export async function withArchitectureWorkspace<T>(
	files: Readonly<Record<string, string>>,
	run: (view: StagedWorkspaceView, root: string) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "trellis-architecture-conformance-"));
	for (const [path, source] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	const view = await stageWorkspaceView({
		root,
		files: productionSelection(Object.keys(files)),
	});
	try {
		return await run(view, root);
	} finally {
		await view.cleanup();
		await rm(root, { recursive: true, force: true });
	}
}

/** One conformance adapter run over a fresh staged workspace. */
export interface ArchitectureConformanceRun {
	adapter: DependencyCruiserAdapterResult;
	/** The normalized evidence of the cruise, when its outcome carried a raw report. */
	normalized: DependencyCruiserNormalizedEvidence | undefined;
}

/** Run the adapter over a fresh staged workspace of `files` under `request`. */
export async function runArchitectureConformance(
	files: Readonly<Record<string, string>> = ARCHITECTURE_FIXTURE,
	request: DependencyCruiserProviderRequest = ARCHITECTURE_REQUEST,
): Promise<ArchitectureConformanceRun> {
	return withArchitectureWorkspace(files, async (view) => {
		const adapter = await runDependencyCruiserAdapter(view, request);
		const outcome = adapter.outcome;
		if (outcome.state !== "complete" && outcome.state !== "incomplete") {
			return { adapter, normalized: undefined };
		}
		if (!("report" in outcome) || outcome.report === undefined) {
			return { adapter, normalized: undefined };
		}
		const coverage =
			"coverage" in outcome && outcome.coverage !== undefined
				? outcome.coverage
				: { selectedFiles: 0, representedFiles: [], missingFiles: [], stubs: [], totalCruised: 0 };
		return {
			adapter,
			normalized: normalizeDependencyCruiserReport(
				outcome.report,
				compileArchitecturePolicy(request),
				coverage,
				view.files.map((file) => file.path),
			),
		};
	});
}

/** Narrow a conformance run's outcome to its complete variant. */
export function requireCompleteCruise(run: ArchitectureConformanceRun): {
	adapter: DependencyCruiserAdapterResult;
	normalized: DependencyCruiserNormalizedEvidence;
} {
	const outcome = run.adapter.outcome;
	if (outcome.state !== "complete") {
		throw new Error(`expected the cruise to complete, got "${outcome.state}": ${outcome.reason}`);
	}
	if (run.normalized === undefined) {
		throw new Error("expected normalized evidence from the completed cruise");
	}
	return { adapter: run.adapter, normalized: run.normalized };
}
