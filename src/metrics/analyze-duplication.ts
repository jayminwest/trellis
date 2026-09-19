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
 * - Any resource exhaustion discards uncommitted groups/totals: every scope
 *   metric is `incomplete` with the located reason and no value. A stopped
 *   traversal is never published as complete or as measured zero debt.
 * - A scope containing files with parse diagnostics is `incomplete` with
 *   partial values (same rule as complexity, SPEC §5.1).
 * - A scope with zero code-classified lines has a `not-applicable` density
 *   (a 0/0 ratio is meaningless); counts stay finite (`0`) and `complete`.
 */
import type { Finding, MetricValue, SourceSet } from "../contract/index.ts";
import type { FileSyntax, SyntaxInventory } from "../syntax/index.ts";
import {
	type BudgetExhaustion,
	type CloneGroup,
	DEFAULT_DUPLICATION_BUDGET,
	type DuplicationBudget,
	locateBudgetExhaustion,
} from "./duplication.ts";
import { measureCandidateScope } from "./duplication-candidate.ts";
import { roundTo } from "./erosion.ts";
import { cloneLineOverlap } from "./line-overlap.ts";

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
	/** Code-classified lines in the scope; null when the pass did not commit totals. */
	codeLines: number | null;
	/** Union of covered code lines; null when the pass did not commit totals. */
	duplicatedLines: number | null;
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

/** Measure one source set: tokenize, detect, and fold groups into scope totals. */
function measureScope(
	sourceSet: SourceSet,
	files: readonly FileSyntax[],
	budget: DuplicationBudget,
): DuplicationScope {
	const detection = measureCandidateScope(files, budget);
	const codeLines = detection.totals?.codeLines ?? null;
	const duplicatedLines = detection.totals?.duplicatedLines ?? null;
	return {
		sourceSet,
		files: files.length,
		tokenCount: detection.tokenCount,
		codeLines,
		duplicatedLines,
		density: detection.totals?.density ?? null,
		groups: detection.groups,
		diagnosticFiles: detection.diagnosticFiles,
		exhaustion: locateBudgetExhaustion(detection.exhaustion),
	};
}

/** The reason a scope could not be fully analyzed (SPEC §3.3), if any. */
function scopeReason(scope: DuplicationScope): string | undefined {
	if (scope.exhaustion?.kind === "token-count") {
		return (
			`token budget of ${scope.exhaustion.limit} exceeded ` +
			`(at least ${scope.tokenCount} observed tokens in ${scope.sourceSet}, phase ${scope.exhaustion.phase}); duplication not measured`
		);
	}
	if (scope.exhaustion?.kind === "match-work") {
		return `match-work budget of ${scope.exhaustion.limit} exceeded in ${scope.exhaustion.phase}; duplication not measured`;
	}
	if (scope.exhaustion !== null) {
		return `${scope.exhaustion.kind} limit ${scope.exhaustion.limit} in ${scope.exhaustion.phase}; duplication not measured`;
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

/** Known compatible numerator/denominator, absent for unmeasured or empty scopes. */
function metricFraction(scope: DuplicationScope) {
	if (
		scope.exhaustion !== null ||
		scope.codeLines === null ||
		scope.codeLines === 0 ||
		scope.duplicatedLines === null
	)
		return undefined;
	return { numerator: scope.duplicatedLines, denominator: scope.codeLines };
}

/** Emit the per-scope metric set: ids carry the source set as their last segment. */
function scopeMetrics(scope: DuplicationScope): MetricValue[] {
	const set = scope.sourceSet;
	const reason = scopeReason(scope);
	const unmeasured = scope.exhaustion !== null;
	const density = scope.density === null ? null : roundTo(scope.density, 6);
	const fraction = metricFraction(scope);
	const detail =
		fraction === undefined
			? undefined
			: {
					...fraction,
					detail: { tokenCount: scope.tokenCount, files: scope.files },
				};
	return [
		metric(`duplication.groups.${set}`, "count", unmeasured ? null : scope.groups.length, reason),
		metric(`duplication.duplicated-lines.${set}`, "lines", scope.duplicatedLines, reason, detail),
		metric(`duplication.density.${set}`, "ratio", density, reason, fraction),
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
				lineOverlap: cloneLineOverlap(group.members),
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
