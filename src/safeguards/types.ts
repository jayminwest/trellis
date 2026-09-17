/**
 * Internal types for safeguard configuration inspection (SPEC §5.5,
 * trellis-a97d).
 *
 * Safeguard inspection reads **configuration surfaces only**: it never runs a
 * hook, imports an executable config, or infers that a check passes. The
 * supported surface formats are a small documented set:
 *
 * - the **root `package.json` manifest** (JSON) — `scripts` entries with
 *   1-based line locations;
 * - **GitHub Actions workflows** (`.github/workflows/*.yml|yaml`) under a
 *   documented line-based subset: only `run:` scalar/block values and `uses:`
 *   values are read; expressions (`${{ }}`), conditionals, and shell semantics
 *   are never evaluated;
 * - **declarative hook configs** — `.pre-commit-config.yaml`, `lefthook.yml`
 *   (and spelling variants), `.husky/` hook files, husky JSON config, and
 *   `git config core.hooksPath <dir>` wiring in manifest scripts;
 * - **Claude Code agent hooks** — the `hooks` map of `.claude/settings.json`;
 * - **JSON budget files** — coverage / file-size budgets and the `.jscpd.json`
 *   duplication budget.
 *
 * Anything outside this set (arbitrary shell programs, executable JS/TS
 * config, runner scripts) is explicitly unverified: it can produce an
 * `unknown` evidence level or a note, never a verified claim.
 */
import type { EvidenceLevel, Finding, SafeguardLocation } from "../contract/index.ts";

/** One `scripts` entry of the root manifest, located by 1-based line. */
export interface ScriptEntry {
	/** Script name (`check:all`). */
	name: string;
	/** Script body, verbatim. */
	body: string;
	/** 1-based line of the `"name":` key inside package.json. */
	line: number;
}

/** The parsed root `package.json` (only the parts safeguards read). */
export interface ManifestModel {
	/** Repo-relative path (`package.json`). */
	path: string;
	/** Scripts with locations; empty when the manifest declares none. */
	scripts: ScriptEntry[];
	/** Raw `jscpd` key config, when present (declarative duplication budget). */
	jscpdConfig: boolean;
	/** Raw `husky` key config, when present (declarative husky v4 config). */
	huskyConfig: boolean;
	/** Set when the manifest exists but is not parseable JSON. */
	parseError?: string;
}

/** One `run:` command extracted from a workflow, located by 1-based line. */
export interface WorkflowCommand {
	/** The command text (one line of a scalar or block `run:`). */
	text: string;
	/** 1-based line in the workflow file. */
	line: number;
}

/** One workflow file reduced to the documented subset. */
export interface WorkflowModel {
	/** Repo-relative POSIX path. */
	path: string;
	/** `run:` commands, in file order. */
	commands: WorkflowCommand[];
	/** `uses:` values (e.g. `pre-commit/action@v3`), in file order. */
	uses: string[];
}

/** Everything an inspector needs: the manifest, the workflows, and file probes. */
export interface SafeguardContext {
	/** Absolute audited root. */
	root: string;
	/** The root manifest, or `null` when no `package.json` exists. */
	manifest: ManifestModel | null;
	/** Every GitHub Actions workflow under the documented subset. */
	workflows: WorkflowModel[];
	/** True when `rel` names an existing file below the root. */
	fileExists: (rel: string) => Promise<boolean>;
	/** True when `rel` names an existing file **or directory** below the root (reference targets). */
	pathExists: (rel: string) => Promise<boolean>;
	/** Read a file as UTF-8 text; `null` when absent or unreadable. */
	readText: (rel: string) => Promise<string | null>;
}

/** Evidence one inspector gathered for one safeguard id. */
export interface SurfaceEvidence {
	/** Highest evidence level observed across this surface. */
	level: EvidenceLevel;
	/** Located configuration surfaces (empty for `absent`). */
	locations: SafeguardLocation[];
	/** Human notes explaining the level (unverified constructs, wiring, …). */
	notes: string[];
	/** Located findings (broken hook/check references). */
	findings: Finding[];
}

/** Evidence ranks for merging: wired beats configured beats unknown beats absent. */
export const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
	absent: 0,
	unknown: 1,
	configured: 2,
	"structurally-wired": 3,
};
