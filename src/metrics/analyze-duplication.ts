/**
 * Duplication analysis over the shared syntax inventory (SPEC §5.3,
 * trellis-6e4c).
 *
 * {@link analyzeDuplication} consumes the one shared parse
 * ({@link SyntaxInventory}) and runs the normalized-token clone detector
 * (`duplication.ts`) **per source set** — `production` and `test` are always
 * measured separately, and token streams are never matched across sets.
 * `generated`, `vendored`, `declaration-only`, and excluded files are never
 * tokenized, so no clone can cross those scopes.
 *
 * Outputs per scope:
 *
 * - stable clone groups (`clone-group-<n>` ids assigned after deterministic
 *   sorting) with member line ranges and copy counts;
 * - the **unique duplicated lines** numerator: the union of code-classified
 *   lines (the syntax layer's §5.1 line rules) covered by any member range,
 *   counted once per file — overlapping or nested groups never
 *   double-count;
 * - the **density** over the documented compatible denominator: the scope's
 *   total code-classified lines (a ratio of compatible quantities);
 * - contract `MetricValue`s (`duplication.groups.<set>`,
 *   `duplication.duplicated-lines.<set>`, `duplication.density.<set>`) and
 *   one `duplication.clone-group` finding per group.
 *
 * State rules (SPEC §3.3):
 *
 * - Token-budget exhaustion means nothing was measured → every scope metric
 *   is `incomplete` with the reason and no value.
 * - Match-work exhaustion means partial detection → `incomplete` with the
 *   partial values and a reason saying so. Resource limits never silently
 *   return a clean result.
 * - A scope containing files with parse diagnostics is `incomplete` with
 *   partial values (same rule as complexity, SPEC §5.1).
 * - A scope with zero code-classified lines has a `not-applicable` density
 *   (a 0/0 ratio is meaningless); counts stay finite (`0`) and `complete`.
 */
import type { Finding, MetricValue, SourceSet } from "../contract/index.ts";
import { classifyLines, type FileSyntax, type SyntaxInventory } from "../syntax/index.ts";
import {
	type BudgetExhaustion,
	type CloneGroup,
	collectTokenStream,
	DEFAULT_DUPLICATION_BUDGET,
	type DuplicationBudget,
} from "./duplication.ts";
import { detectClones } from "./duplication-detect.ts";
import { roundTo } from "./erosion.ts";

/** The source sets duplication measurement covers (SPEC §3.1: scored sets, separately). */
const MEASURED_SETS = ["production", "test"] as const;

/** Options for {@link analyzeDuplication}. */
export interface DuplicationOptions {
	/** Resource budgets for the detection run (default {@link DEFAULT_DUPLICATION_BUDGET}). */
	budget?: DuplicationBudget;
}

/** One source set's duplication measurement. */
export interface DuplicationScope {
	sourceSet: SourceSet;
	/** Files tokenized in this scope. */
	files: number;
	/** Normalized tokens tokenized in this scope. */
	tokenCount: number;
	/** Code-classified lines in the scope (the density denominator). */
	codeLines: number;
	/** Union of code-classified lines covered by clone members (the numerator). */
	duplicatedLines: number;
	/** `duplicatedLines / codeLines`; `null` when the scope has no code lines. */
	density: number | null;
	/** Surviving clone groups, deterministically ordered. */
	groups: CloneGroup[];
	/** Files in this scope that produced parse diagnostics (partial measurement). */
	diagnosticFiles: string[];
	/** The budget that tripped, or `null` when detection completed. */
	exhaustion: BudgetExhaustion | null;
}

/** The full duplication measurement of one audit. */
export interface DuplicationAnalysis {
	scopes: {
		production: DuplicationScope;
		test: DuplicationScope;
	};
	/** Contract metric values (SPEC §6.1), sorted by id. Ids end in the source set. */
	metrics: MetricValue[];
	/** One `duplication.clone-group` finding per group, in scope then group order. */
	findings: Finding[];
}

/**
 * Union of code-classified lines covered by any member range in `groups`
 * for one file — counted once, so overlapping groups never double-count.
 */
function duplicatedCodeLines(file: FileSyntax, groups: readonly CloneGroup[]): number {
	const ranges = groups.flatMap((group) =>
		group.members
			.filter((member) => member.path === file.path)
			.map((member) => ({ start: member.range.start.line, end: member.range.end.line })),
	);
	if (ranges.length === 0) return 0;
	const kinds = classifyLines(file.sourceFile);
	const covered = new Array<boolean>(kinds.length).fill(false);
	for (const range of ranges) {
		const last = Math.min(range.end, kinds.length);
		for (let line = range.start; line <= last; line += 1) covered[line - 1] = true;
	}
	let count = 0;
	for (const [index, kind] of kinds.entries()) {
		if (covered[index] && kind === "code") count += 1;
	}
	return count;
}

/** Measure one source set: tokenize, detect, and fold groups into scope totals. */
function measureScope(
	sourceSet: SourceSet,
	files: readonly FileSyntax[],
	budget: DuplicationBudget,
): DuplicationScope {
	const streams = files.map((file) => collectTokenStream(file));
	const detection = detectClones(streams, budget);
	const codeLines = files.reduce((sum, file) => sum + file.lines.code, 0);
	const duplicatedLines = files.reduce(
		(sum, file) => sum + duplicatedCodeLines(file, detection.groups),
		0,
	);
	return {
		sourceSet,
		files: files.length,
		tokenCount: detection.tokenCount,
		codeLines,
		duplicatedLines,
		density: codeLines === 0 ? null : duplicatedLines / codeLines,
		groups: detection.groups,
		diagnosticFiles: files
			.filter((file) => file.diagnostics.length > 0)
			.map((file) => file.path)
			.sort(),
		exhaustion: detection.exhaustion,
	};
}

/** The reason a scope could not be fully analyzed (SPEC §3.3), if any. */
function scopeReason(scope: DuplicationScope): string | undefined {
	if (scope.exhaustion?.kind === "token-count") {
		return (
			`token budget of ${scope.exhaustion.limit} exceeded ` +
			`(${scope.tokenCount} tokens in the ${scope.sourceSet} set); duplication not measured`
		);
	}
	if (scope.exhaustion?.kind === "match-work") {
		return `match-work budget of ${scope.exhaustion.limit} exceeded; duplication results are partial`;
	}
	const n = scope.diagnosticFiles.length;
	return n === 0
		? undefined
		: `${n} ${scope.sourceSet} file(s) produced parse diagnostics; values are partial`;
}

/** One metric's state + optional value under the documented state rules. */
function stateAndValue(
	value: number | null,
	reason: string | undefined,
): Pick<MetricValue, "state" | "value" | "reason"> {
	if (reason !== undefined) {
		return value === null
			? { state: "incomplete", reason }
			: { state: "incomplete", value, reason };
	}
	return value === null ? { state: "not-applicable" } : { state: "complete", value };
}

/** Build one contract metric from a computed (nullable) value. */
function metric(
	id: string,
	unit: string,
	value: number | null,
	reason: string | undefined,
	extra?: Partial<Pick<MetricValue, "numerator" | "denominator" | "detail">>,
): MetricValue {
	return { id, unit, ...stateAndValue(value, reason), ...extra };
}

/** Emit the per-scope metric set: ids carry the source set as their last segment. */
function scopeMetrics(scope: DuplicationScope): MetricValue[] {
	const set = scope.sourceSet;
	const reason = scopeReason(scope);
	const unmeasured = scope.exhaustion?.kind === "token-count";
	const density = scope.density === null ? null : roundTo(scope.density, 6);
	return [
		metric(`duplication.groups.${set}`, "count", unmeasured ? null : scope.groups.length, reason),
		metric(
			`duplication.duplicated-lines.${set}`,
			"lines",
			unmeasured ? null : scope.duplicatedLines,
			reason,
			unmeasured || scope.codeLines === 0
				? undefined
				: {
						numerator: scope.duplicatedLines,
						denominator: scope.codeLines,
						detail: { tokenCount: scope.tokenCount, files: scope.files },
					},
		),
		metric(
			`duplication.density.${set}`,
			"ratio",
			unmeasured ? null : density,
			reason,
			unmeasured || scope.codeLines === 0
				? undefined
				: { numerator: scope.duplicatedLines, denominator: scope.codeLines },
		),
	];
}

/** One finding per clone group (SPEC §6.2); group order is already deterministic. */
function groupFindings(scope: DuplicationScope): Finding[] {
	return scope.groups.map((group) => {
		const first = group.members[0];
		return {
			kind: "duplication.clone-group",
			path: first?.path ?? "",
			range: first?.range ?? { start: { line: 1 }, end: { line: 1 } },
			summary: `${group.members.length} copies of ${group.tokenCount} normalized tokens`,
			facts: {
				groupId: group.id,
				sourceSet: scope.sourceSet,
				memberCount: group.members.length,
				tokenCount: group.tokenCount,
				members: group.members.map((member) => ({
					path: member.path,
					startLine: member.range.start.line,
					endLine: member.range.end.line,
				})),
			},
		};
	});
}

/**
 * Measure duplication over the shared syntax inventory (see the module
 * docblock for states and outputs). Pure and synchronous: the inventory
 * already holds every parse, so same inventory in ⇒ byte-equal measurement
 * out (SPEC §3.5).
 */
export function analyzeDuplication(
	inventory: SyntaxInventory,
	options: DuplicationOptions = {},
): DuplicationAnalysis {
	const budget = options.budget ?? DEFAULT_DUPLICATION_BUDGET;
	const measuredFiles = inventory.files.filter((file) =>
		(MEASURED_SETS as readonly string[]).includes(file.sourceSet),
	);
	const scopes = {
		production: measureScope(
			"production",
			measuredFiles.filter((file) => file.sourceSet === "production"),
			budget,
		),
		test: measureScope(
			"test",
			measuredFiles.filter((file) => file.sourceSet === "test"),
			budget,
		),
	};
	const metrics = [...scopeMetrics(scopes.production), ...scopeMetrics(scopes.test)].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const findings = [...groupFindings(scopes.production), ...groupFindings(scopes.test)];
	return { scopes, metrics, findings };
}
