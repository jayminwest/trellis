/**
 * Trellis-owned line accounting for jscpd clone observations (SPEC §16.5,
 * plan `pl-43c5` — trellis-da4c, step 13).
 *
 * jscpd's own statistics (`duplicatedLines`, `percentage`) count *its* units
 * over *its* line accounting — the spike recorded two identical 14-line
 * files as "46.43% duplicated" where the union of affected code lines is
 * 28/28. Those provider totals are retained elsewhere for explanation only
 * and never imported as trellis accounting; this module owns the trellis
 * side of the ledger:
 *
 * - **Classification** — every accounted file's lines are classified with
 *   the shared syntax layer's scanner classifier (`classifyLines`, §5.1
 *   rules): a line is `code` when a real token covers it; comment-only and
 *   blank lines are never countable affected lines, and a clone whose span
 *   covers comments and blanks still counts only its code lines.
 * - **Union semantics** — a clone member covers its whole reported line
 *   span, and covered lines are unioned **per file**: overlapping, nested,
 *   or repeated clones never double-count a line (the same union rule as
 *   the native duplication analyzer's numerator).
 * - **Source-set separation** — every accounted file accounts in exactly
 *   one source set; the accounting keeps `production` and `test` separate.
 *   jscpd matches across the whole staged view (it has no source-set
 *   notion), so one clone pair can affect lines in both sets — each side
 *   is accounted in its own file's set, never merged.
 *
 * The accounting denominator is the accounted selection's own
 * code-classified lines (the enumerable scope trellis handed the tool) —
 * never jscpd's `statistics.lines`, which omits below-threshold files.
 *
 * Pure: file content arrives as data; nothing is read, written, executed,
 * or scored.
 */
import type { SourceSet } from "../../contract/index.ts";
import { classifyLines, type LineKind, parseSource } from "../../syntax/index.ts";

/**
 * Operational error (SPEC §16.3): the accounting inputs are inconsistent —
 * a duplicate accounted file, a clone member outside the accounted
 * selection, or a file outside the measured source sets. Validated evidence
 * over a matching selection never trips this; callers that fold raw reports
 * translate it as an operational failure, never as clean evidence.
 */
export class InvalidJscpdEvidenceError extends Error {
	constructor(reason: string) {
		super(`invalid jscpd evidence: ${reason}`);
		this.name = "InvalidJscpdEvidenceError";
	}
}

/** One staged source file this module accounts over. */
export interface JscpdAccountedFile {
	/** Repo-relative POSIX path (matches the staged selection). */
	path: string;
	/** The measured source set this file's lines account in. */
	sourceSet: Extract<SourceSet, "production" | "test">;
	/** The staged content to classify (bytes as text, exactly as staged). */
	text: string;
}

/** One clone member's covered line span, as the provider reported it. */
export interface JscpdCloneMemberSpan {
	/** Repo-relative POSIX path of the covered file. */
	path: string;
	/** 1-based first covered line. */
	startLine: number;
	/** 1-based last covered line (never precedes `startLine`). */
	endLine: number;
}

/** One source set's trellis-owned line account. */
export interface JscpdLineAccount {
	/** Accounted files in this source set. */
	files: number;
	/** Code-classified lines across those files (the accounting denominator). */
	codeLines: number;
	/** Union of code-classified lines covered by any clone member, once per file. */
	affectedCodeLines: number;
}

/** The per-source-set line accounts (production and test, kept separate). */
export interface JscpdLineAccounts {
	production: JscpdLineAccount;
	test: JscpdLineAccount;
}

/** One accounted file with its classified lines. */
interface ClassifiedFile {
	file: JscpdAccountedFile;
	kinds: readonly LineKind[];
}

/** Reject inputs that are not one consistent accounted selection. */
function requireAccountable(file: JscpdAccountedFile, seen: ReadonlySet<string>): void {
	if (seen.has(file.path)) {
		throw new InvalidJscpdEvidenceError(`accounted file "${file.path}" is listed more than once`);
	}
	if (file.sourceSet !== "production" && file.sourceSet !== "test") {
		throw new InvalidJscpdEvidenceError(
			`accounted file "${file.path}" belongs to the ${JSON.stringify(file.sourceSet)} source set; ` +
				"jscpd line accounting covers the measured production/test sets only",
		);
	}
}

/** Index the accounted selection: validated, unique, and classified per file. */
function indexAccountedFiles(files: readonly JscpdAccountedFile[]): Map<string, ClassifiedFile> {
	const byPath = new Map<string, ClassifiedFile>();
	const seen = new Set<string>();
	for (const file of files) {
		requireAccountable(file, seen);
		seen.add(file.path);
		byPath.set(file.path, {
			file,
			kinds: classifyLines(parseSource(file.path, file.text).sourceFile),
		});
	}
	return byPath;
}

/** Mark one member's covered lines in the per-file union flags. */
function coverMember(flags: boolean[], member: JscpdCloneMemberSpan, lineCount: number): void {
	const first = Math.max(1, member.startLine);
	const last = Math.min(member.endLine, lineCount);
	for (let line = first; line <= last; line += 1) flags[line - 1] = true;
}

/** Union every member's covered lines per file (rejecting unaccountable spans). */
function coveredLinesByPath(
	members: readonly JscpdCloneMemberSpan[],
	byPath: Map<string, ClassifiedFile>,
): Map<string, boolean[]> {
	const covered = new Map<string, boolean[]>();
	for (const member of members) {
		const accounted = byPath.get(member.path);
		if (accounted === undefined) {
			throw new InvalidJscpdEvidenceError(
				`clone member references "${member.path}", which is not an accounted file`,
			);
		}
		if (member.endLine < member.startLine) {
			throw new InvalidJscpdEvidenceError(
				`clone member span in "${member.path}" ends (${member.endLine}) before it starts (${member.startLine})`,
			);
		}
		let flags = covered.get(member.path);
		if (flags === undefined) {
			flags = new Array<boolean>(accounted.kinds.length).fill(false);
			covered.set(member.path, flags);
		}
		coverMember(flags, member, accounted.kinds.length);
	}
	return covered;
}

/** Fold one classified file's lines into its source set's account. */
function foldFile(
	account: JscpdLineAccount,
	entry: ClassifiedFile,
	flags: boolean[] | undefined,
): void {
	account.files += 1;
	for (const [index, kind] of entry.kinds.entries()) {
		if (kind !== "code") continue;
		account.codeLines += 1;
		if (flags !== undefined && flags[index] === true) account.affectedCodeLines += 1;
	}
}

/**
 * Account clone-member line spans over the accounted selection (see the
 * module docblock for the exact classification, union, and separation
 * semantics). Both members of every reported clone should be passed as
 * members; the union makes overlaps and repeats count once.
 */
export function accountCloneLines(
	files: readonly JscpdAccountedFile[],
	members: readonly JscpdCloneMemberSpan[],
): JscpdLineAccounts {
	const byPath = indexAccountedFiles(files);
	const covered = coveredLinesByPath(members, byPath);
	const accounts: JscpdLineAccounts = {
		production: { files: 0, codeLines: 0, affectedCodeLines: 0 },
		test: { files: 0, codeLines: 0, affectedCodeLines: 0 },
	};
	for (const entry of byPath.values()) {
		foldFile(accounts[entry.file.sourceSet], entry, covered.get(entry.file.path));
	}
	return accounts;
}
