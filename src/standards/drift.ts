/**
 * Canonical-config drift engine (SPEC §11). Compares a target repo against the
 * bundled canonical set (see `manifest.ts`) and reports, per file, how far it has
 * drifted — honoring per-repo **allowed deltas** so whitelisted divergences read
 * as `allowed-delta` rather than `drift`.
 *
 * The comparison is matcher-driven (one {@link MatcherKind} per canonical file):
 *   - `exact`     — byte-for-byte identity (fixed scripts/hooks).
 *   - `text`      — whitespace/line-ending–normalized text equality.
 *   - `json-subset` / `yaml-subset` — canonical *object keys* must be present and
 *     deep-equal; the target may add keys (surfaced as `extra`). Arrays and
 *     primitives must match exactly — extend an array via an allowed delta.
 *   - `template`  — section-aware: the canonical doc's required headings must all
 *     appear in the target (`<<TOKEN>>` headings act as wildcards); extra target
 *     sections read as `extra`.
 *
 * Each mismatch is a {@link Divergence} carrying a structural path within the
 * file, so an allowed delta can whitelist either a whole file or specific paths.
 * State resolution (SPEC §11): `missing` (target lacks the file) → `drift` (an
 * unwhitelisted required divergence) → `allowed-delta` (every required divergence
 * is whitelisted) → `extra` (only target-side additions) → `match`. Only `drift`
 * and `missing` are failing states; `extra`/`allowed-delta`/`match` are clean.
 *
 * This module is surface-agnostic core (no I/O beyond reading the two files it
 * compares); `drift-report.ts` renders a {@link DriftReport}, and the CLI/SDK
 * fold it. `trellis drift` runs it standalone (allowed deltas default empty); the
 * fleet (trellis-6eb1) supplies per-repo deltas from `targets.yaml`.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseYaml } from "../contract/yaml.ts";
import type { DriftState } from "./drift-states.ts";
import {
	loadManifest,
	type Manifest,
	type ManifestFile,
	type MatcherKind,
	readCanonical,
} from "./manifest.ts";

/** How a single point in a file diverges from canonical. */
export type DivergenceKind =
	/** Canonical requires a key/value the target lacks. */
	| "missing"
	/** Both sides have the path but the values differ. */
	| "changed"
	/** The target adds a key/section canonical does not define (informational). */
	| "added";

/** One concrete divergence between a target file and its canonical form. */
export interface Divergence {
	/** Structural path within the file (`linter.rules.style.useConst`, `section:Mission`, `""` = whole file). */
	path: string;
	kind: DivergenceKind;
	/** Human-readable explanation of the divergence. */
	detail: string;
}

/**
 * A whitelisted divergence (SPEC §6.5 `targets.yaml` → `canonical.allowedDeltas`).
 * `paths` absent ⇒ the whole file may diverge; otherwise only the listed
 * structural paths (and their descendants) are whitelisted. `reason` is required
 * for traceability.
 */
export interface AllowedDelta {
	file: string;
	paths?: string[];
	reason: string;
}

/** Drift outcome for one canonical file. */
export interface FileDrift {
	/** Target-repo-relative path of the file (the manifest `path`). */
	path: string;
	matcher: MatcherKind;
	/** Canonical version of this file (from the manifest). */
	version: string;
	state: DriftState;
	/** The divergences that drove the state (unallowed ones for `drift`; empty for `match`/`missing`). */
	divergences: Divergence[];
	/** Allowed-delta entries that matched (only populated for the `allowed-delta` state). */
	allowedBy: AllowedDelta[];
}

/** Whole-repo drift result, separate from the scored audit report (SPEC §11). */
export interface DriftReport {
	/** Repo id — basename of the audited path (the fleet supplies the real id later). */
	repo: string;
	/** Canonical set version compared against (resolved per-repo, SPEC §11). */
	canonicalVersion: string;
	/** Per-file results, in manifest order. */
	files: FileDrift[];
	/** Count of files in each state, for headline rendering / `--fail-on drift`. */
	summary: Record<DriftState, number>;
}

/** A drift run failure (e.g. an unavailable canonical version). */
export class DriftError extends Error {
	override readonly name = "DriftError";
}

/** Options for {@link driftRepo}. All optional — defaults give a real standalone run. */
export interface DriftOptions {
	/** Requested canonical set version; defaults to the bundled manifest's version. */
	canonicalVersion?: string;
	/** Per-repo whitelist (SPEC §6.5); standalone `trellis drift` defaults to empty. */
	allowedDeltas?: readonly AllowedDelta[];
	/**
	 * Repo id stamped on the {@link DriftReport} — the fleet supplies the
	 * `targets.yaml` id (SPEC §6.5); defaults to the audited path's basename.
	 */
	repoId?: string;
	/** Test hook: load the manifest from an alternate directory. */
	manifestDir?: string;
	/** Test hook: read canonical bytes from an alternate directory. */
	canonicalDir?: string;
}

/**
 * Resolve which canonical version a target compares against (SPEC §11):
 * per-repo override > fleet `defaults.canonicalVersion` > `fallback` (the bundled
 * set's version). Pure so the fleet loader and the drift CLI share one rule.
 */
export function resolveCanonicalVersion(
	perRepoOverride: string | undefined,
	defaultVersion: string | undefined,
	fallback: string,
): string {
	return perRepoOverride ?? defaultVersion ?? fallback;
}

/** True for a non-null, non-array object — the only shape subset-walked key-by-key. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural deep equality over JSON-shaped values (objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((x, i) => deepEqual(x, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const ak = Object.keys(a);
		const bk = Object.keys(b);
		return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]));
	}
	return false;
}

/** Join a base path and a key into a dotted structural path. */
function childPath(base: string, key: string): string {
	return base === "" ? key : `${base}.${key}`;
}

/**
 * Subset divergences of `target` against `canon` rooted at `base` (SPEC §11
 * json/yaml-subset): every canonical object key must be present and deep-equal;
 * target-only keys are reported as `added`; arrays/primitives must match exactly.
 */
function subsetDivergences(canon: unknown, target: unknown, base: string): Divergence[] {
	if (isPlainObject(canon) && isPlainObject(target)) {
		const out: Divergence[] = [];
		for (const key of Object.keys(canon)) {
			if (!(key in target)) {
				out.push({ path: childPath(base, key), kind: "missing", detail: "canonical key absent" });
				continue;
			}
			out.push(...subsetDivergences(canon[key], target[key], childPath(base, key)));
		}
		for (const key of Object.keys(target)) {
			if (!(key in canon)) {
				out.push({ path: childPath(base, key), kind: "added", detail: "target-only key" });
			}
		}
		return out;
	}
	if (deepEqual(canon, target)) return [];
	const where = base === "" ? "value" : base;
	return [{ path: base, kind: "changed", detail: `${where} differs from canonical` }];
}

/** Parse JSON, returning `undefined` on any parse error (the target may be malformed). */
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Parse a single YAML document, returning `undefined` on any parse error. */
function tryParseYaml(text: string): unknown {
	try {
		return parseYaml(text);
	} catch {
		return undefined;
	}
}

/** A whole-file `changed` divergence (exact/text mismatch, or an unparseable target). */
function wholeFileChanged(detail: string): Divergence[] {
	return [{ path: "", kind: "changed", detail }];
}

/** Subset-compare a target parsed by `parse`; a parse failure is a whole-file drift. */
function structuredDivergences(
	parse: (text: string) => unknown,
	label: string,
	canonText: string,
	targetText: string,
): Divergence[] {
	const target = parse(targetText);
	if (target === undefined) return wholeFileChanged(`target is not valid ${label}`);
	return subsetDivergences(parse(canonText), target, "");
}

/** Normalize text for the `text` matcher: LF endings, trimmed line ends, no blank edges. */
function normalizeText(text: string): string {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""));
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

/** Markdown headings to ignore as template scaffolding (instructional, removed by consumers). */
const TEMPLATE_SCAFFOLD = [/^replaceable tokens$/];

/** Normalize a heading for comparison: collapsed whitespace, lower-cased. */
function normalizeHeading(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Extract top-level (`##`) section headings outside fenced code blocks, as
 * normalized text. The template matcher works at the major-section granularity:
 * deeper `###`+ subsections are finer structure a repo may reorganize freely.
 */
function sectionHeadings(md: string): string[] {
	const out: string[] = [];
	let fenced = false;
	for (const line of md.split("\n")) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m?.[1]) out.push(normalizeHeading(m[1]));
	}
	return out;
}

/** Build a matcher for a canonical heading; `<<TOKEN>>` placeholders match anything. */
function headingMatcher(canonHeading: string): RegExp {
	const pattern = canonHeading
		.split(/<<[^>]*>>/g)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`);
}

/** True if any target heading satisfies the canonical heading's (token-aware) matcher. */
function hasSection(canonHeading: string, targetHeadings: string[]): boolean {
	const re = headingMatcher(canonHeading);
	return targetHeadings.some((h) => re.test(h));
}

/**
 * Template (section-aware) divergences: every required canonical section must
 * appear in the target; target-only sections are `added`. Scaffolding headings
 * (consumer-removed instructions) are not required.
 */
function templateDivergences(canonText: string, targetText: string): Divergence[] {
	const required = sectionHeadings(canonText).filter(
		(h) => !TEMPLATE_SCAFFOLD.some((re) => re.test(h)),
	);
	const targetHeadings = sectionHeadings(targetText);
	const out: Divergence[] = [];
	for (const heading of required) {
		if (!hasSection(heading, targetHeadings)) {
			out.push({ path: `section:${heading}`, kind: "missing", detail: "required section absent" });
		}
	}
	const requiredSet = new Set(required);
	for (const heading of targetHeadings) {
		if (!requiredSet.has(heading) && !TEMPLATE_SCAFFOLD.some((re) => re.test(heading))) {
			out.push({ path: `section:${heading}`, kind: "added", detail: "target-only section" });
		}
	}
	return out;
}

/** Compare a target file's bytes against canonical under the file's matcher. */
function compareContent(matcher: MatcherKind, canon: Buffer, target: Buffer): Divergence[] {
	switch (matcher) {
		case "exact":
			return canon.equals(target) ? [] : wholeFileChanged("bytes differ from canonical");
		case "text":
			return normalizeText(canon.toString()) === normalizeText(target.toString())
				? []
				: wholeFileChanged("normalized text differs from canonical");
		case "json-subset":
			return structuredDivergences(tryParseJson, "JSON", canon.toString(), target.toString());
		case "yaml-subset":
			return structuredDivergences(tryParseYaml, "YAML", canon.toString(), target.toString());
		case "template":
			return templateDivergences(canon.toString(), target.toString());
	}
}

/** True if `delta` whitelists a divergence at `path` (whole-file, or a path prefix). */
function deltaCovers(delta: AllowedDelta, path: string): boolean {
	if (delta.paths === undefined || delta.paths.length === 0) return true;
	return delta.paths.some((p) => path === p || path.startsWith(`${p}.`));
}

/** Resolve a file's drift state from its divergences and the deltas scoped to it. */
function resolveState(
	divergences: Divergence[],
	deltas: AllowedDelta[],
): Pick<FileDrift, "state" | "divergences" | "allowedBy"> {
	const required = divergences.filter((d) => d.kind !== "added");
	const added = divergences.filter((d) => d.kind === "added");
	const unallowed = required.filter((d) => !deltas.some((delta) => deltaCovers(delta, d.path)));

	if (unallowed.length > 0) return { state: "drift", divergences: unallowed, allowedBy: [] };
	if (required.length > 0) {
		const allowedBy = deltas.filter((delta) => required.some((d) => deltaCovers(delta, d.path)));
		return { state: "allowed-delta", divergences: required, allowedBy };
	}
	if (added.length > 0) return { state: "extra", divergences: added, allowedBy: [] };
	return { state: "match", divergences: [], allowedBy: [] };
}

/** Drift one canonical file against the target repo at `root`. */
function driftFile(
	root: string,
	file: ManifestFile,
	deltas: AllowedDelta[],
	canonicalDir: string | undefined,
): FileDrift {
	const base = { path: file.path, matcher: file.matcher, version: file.version };
	let target: Buffer;
	try {
		target = readFileSync(join(root, file.path));
	} catch {
		return { ...base, state: "missing", divergences: [], allowedBy: [] };
	}
	const canon = readCanonical(file.path, canonicalDir);
	const divergences = compareContent(file.matcher, canon, target);
	const fileDeltas = deltas.filter((d) => d.file === file.path);
	return { ...base, ...resolveState(divergences, fileDeltas) };
}

/** Zero-initialized per-state summary, mutated as files resolve. */
function emptySummary(): Record<DriftState, number> {
	return { match: 0, "allowed-delta": 0, drift: 0, missing: 0, extra: 0 };
}

/**
 * Compare the repo at `repoPath` against the bundled canonical set and return its
 * {@link DriftReport}. The requested canonical version (default: the bundled
 * manifest's) must be one trellis ships, else a {@link DriftError}. Pure given
 * (checkout, manifest, allowed deltas) — no wall-clock or network input — so a
 * re-run on an unchanged tree is byte-identical.
 */
export function driftRepo(repoPath: string, opts: DriftOptions = {}): DriftReport {
	const manifest: Manifest = loadManifest(opts.manifestDir);
	const canonicalVersion = resolveCanonicalVersion(
		opts.canonicalVersion,
		undefined,
		manifest.version,
	);
	if (canonicalVersion !== manifest.version) {
		throw new DriftError(
			`canonical version ${canonicalVersion} is not bundled (have ${manifest.version})`,
		);
	}
	const deltas = [...(opts.allowedDeltas ?? [])];
	const files = manifest.files.map((file) => driftFile(repoPath, file, deltas, opts.canonicalDir));
	const summary = emptySummary();
	for (const file of files) summary[file.state] += 1;
	return { repo: opts.repoId ?? basename(repoPath), canonicalVersion, files, summary };
}
