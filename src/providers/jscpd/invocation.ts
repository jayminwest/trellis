/**
 * Pinned jscpd invocation modes and identity construction (SPEC §16.2/
 * §16.4, plan `pl-43c5` — trellis-f4e2, step 12).
 *
 * Every jscpd process this adapter starts uses the **explicit, pinned flag
 * set** built here — the only argv `adapter.ts` ever passes to the
 * controlled process runner (`../process.ts`, which accepts only
 * executables resolved through the pinned-tool manifest, `../resolve.ts`):
 *
 * - **`--config <owned empty config>`** — jscpd auto-discovers ancestor
 *   `.jscpd.json` files; the adapter points it at a trellis-owned empty
 *   `{}` inside the staged scratch, so no ancestor config of the target,
 *   the scratch parent, or the operator can change the staged scope.
 * - **`--no-gitignore`** — `.gitignore` files can never filter the staged
 *   selection.
 * - **`--mode weak`** (comment tokens never match), **`--workers 1`**
 *   (deterministic execution), **`--max-size 100mb`** (bounded inputs), and
 *   the calibrated thresholds below.
 * - **Explicitly never passed**: `--exit-code`, `--threshold`,
 *   `--baseline*`, `--blame`, `--follow-symlinks`, `--absolute`,
 *   `--pattern`, `--cross-formats`, `--ignore-pattern` — no target-directed
 *   behavior, no baseline rewrites, no extra filesystem surface.
 *
 * The three invocation modes (the contract's match modes) each add their
 * observed flag set, from the research spike: `exact` (token identity),
 * `normalized` (`--ignore-identifiers --ignore-literals`), `near` (also
 * `--max-gap-lines` + `--similarity`, reporting AST/gap near misses).
 *
 * Identity (§16.2): provider identity records the exact mode/option set;
 * analysis identity records the staged selection (content-fingerprinted,
 * sorted), jscpd's own parser identity, and the trellis-owned declarative
 * options — never machine paths, timestamps or durations.
 */
import { join } from "node:path";
import { z } from "zod";
import type {
	AnalysisIdentity,
	CloneMatchMode,
	ProviderIdentity,
	ProviderOptions,
	SourceSelection,
} from "../../contract/index.ts";
import { pinnedTool } from "../manifest.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import { JSCPD_ADAPTER_VERSION, JSCPD_PARSER_ENGINE, JSCPD_PROVIDER_ID } from "./raw.ts";

/** Operational error (SPEC §16.3): the jscpd request or selection is invalid. */
export class InvalidJscpdRequestError extends Error {
	constructor(reason: string) {
		super(`invalid jscpd request: ${reason}`);
		this.name = "InvalidJscpdRequestError";
	}
}

/** Validated threshold shape: positive token/line floors, a similarity ratio in (0, 1]. */
export const jscpdThresholdsSchema = z.strictObject({
	minTokens: z.number().int().positive(),
	minLines: z.number().int().positive(),
	maxGapLines: z.number().int().nonnegative(),
	similarity: z.number().finite().gt(0).lte(1),
});
export type JscpdThresholds = z.infer<typeof jscpdThresholdsSchema>;

/**
 * The pinned detection thresholds (the spike calibration): the minimum
 * tokens/lines a clone must span, and for `near` mode the maximum
 * unmatched gap the tool may merge and the AST similarity floor.
 */
export const JSCPD_DEFAULT_THRESHOLDS: JscpdThresholds = {
	minTokens: 50,
	minLines: 3,
	maxGapLines: 2,
	similarity: 0.85,
};

/** The jscpd detection mode: comment tokens never match (spike calibration). */
const JSCPD_DETECTION_MODE = "weak";

/** Per-file size ceiling the adapter hands the tool (bounded inputs). */
const JSCPD_MAX_FILE_SIZE = "100mb";

/** Deterministic worker count: one worker, no auto scaling. */
const JSCPD_WORKERS = 1;

/** The manifest entry of the pinned jscpd tool (module-load invariant: it exists). */
function pinnedJscpdEntry() {
	const entry = pinnedTool(JSCPD_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${JSCPD_PROVIDER_ID}"`);
	}
	return entry;
}

/** The pinned jscpd tool version (provider and parser identity, SPEC §16.2). */
export function jscpdPinnedToolVersion(): string {
	return pinnedJscpdEntry().pinnedVersion;
}

/** The exact `--version` stdout the pinned tool must report (verified at invocation). */
export function expectedJscpdVersionOutput(): string {
	return pinnedJscpdEntry().versionOutput;
}

/** The mode-specific flags each invocation mode adds (observed spike flag sets). */
export function jscpdModeFlags(mode: CloneMatchMode, thresholds: JscpdThresholds): string[] {
	if (mode === "exact") {
		return [];
	}
	if (mode === "normalized") {
		return ["--ignore-identifiers", "--ignore-literals"];
	}
	return [
		"--ignore-identifiers",
		"--ignore-literals",
		"--max-gap-lines",
		String(thresholds.maxGapLines),
		"--similarity",
		String(thresholds.similarity),
	];
}

/** The trellis-owned option set a mode applies (recorded in identity, §16.2). */
export function jscpdProviderOptions(
	mode: CloneMatchMode,
	thresholds: JscpdThresholds,
): ProviderOptions {
	const options: ProviderOptions = {
		"min-tokens": thresholds.minTokens,
		"min-lines": thresholds.minLines,
		"skip-comments": true,
		"no-gitignore": true,
		workers: JSCPD_WORKERS,
		"max-size": JSCPD_MAX_FILE_SIZE,
		reporters: "json",
	};
	if (mode === "normalized" || mode === "near") {
		options["ignore-identifiers"] = true;
		options["ignore-literals"] = true;
	}
	if (mode === "near") {
		options["max-gap-lines"] = thresholds.maxGapLines;
		options.similarity = thresholds.similarity;
	}
	return options;
}

/** The fixed argv one mode runs: the staged scope plus every pinned flag. */
export function jscpdInvocationArgs(input: {
	stagedRoot: string;
	configPath: string;
	outputDir: string;
	mode: CloneMatchMode;
	thresholds: JscpdThresholds;
}): string[] {
	return [
		input.stagedRoot,
		"--config",
		input.configPath,
		"--min-tokens",
		String(input.thresholds.minTokens),
		"--min-lines",
		String(input.thresholds.minLines),
		"--mode",
		JSCPD_DETECTION_MODE,
		"--no-gitignore",
		"--workers",
		String(JSCPD_WORKERS),
		"--max-size",
		JSCPD_MAX_FILE_SIZE,
		"--reporters",
		"json",
		"--output",
		input.outputDir,
		"--silent",
		"--no-tips",
		...jscpdModeFlags(input.mode, input.thresholds),
	];
}

/** The provider identity of one jscpd mode run (§16.2). */
export function jscpdProviderIdentity(
	mode: CloneMatchMode,
	thresholds: JscpdThresholds,
): ProviderIdentity {
	return {
		kind: "external",
		id: JSCPD_PROVIDER_ID,
		toolVersion: jscpdPinnedToolVersion(),
		adapterVersion: JSCPD_ADAPTER_VERSION,
		mode,
		options: jscpdProviderOptions(mode, thresholds),
	};
}

/**
 * The staged view's source selection (§16.2 analysis-identity input): the
 * source sets it covers and its files with content fingerprints, unique
 * and sorted. An empty staged selection cannot produce a contract
 * selection — the caller rejects empty selections before running.
 */
export function sourceSelectionFromStagedView(view: StagedWorkspaceView): SourceSelection {
	if (view.files.length === 0) {
		throw new InvalidJscpdRequestError(
			"the staged selection is empty — jscpd evidence requires at least one staged file",
		);
	}
	return {
		sourceSets: [...new Set(view.files.map((file) => file.sourceSet))].sort(),
		files: view.files
			.map((file) => ({ path: file.path, fingerprint: file.sha256 }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	};
}

/** The analysis identity of one mode run: staged selection, jscpd's parser, the declarative options (§16.2). */
export function jscpdAnalysisIdentity(
	view: StagedWorkspaceView,
	mode: CloneMatchMode,
	thresholds: JscpdThresholds,
): AnalysisIdentity {
	return {
		selection: sourceSelectionFromStagedView(view),
		parser: { engine: JSCPD_PARSER_ENGINE, version: jscpdPinnedToolVersion() },
		options: jscpdProviderOptions(mode, thresholds),
	};
}

/** Where the adapter stages its owned empty jscpd config (inside the scratch work area). */
export function jscpdConfigPath(view: StagedWorkspaceView): string {
	return join(view.workDir, "config.json");
}

/** Where one mode's owned report output directory lives (inside the work area). */
export function jscpdOutputDir(view: StagedWorkspaceView, mode: CloneMatchMode): string {
	return join(view.workDir, `report-${mode}`);
}
