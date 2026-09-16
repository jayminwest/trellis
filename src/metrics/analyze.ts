/**
 * Complexity & erosion analysis over the shared syntax inventory
 * (SPEC §5.1–5.2, trellis-fbc5).
 *
 * {@link analyzeComplexity} consumes the one shared parse
 * ({@link SyntaxInventory}) and produces:
 *
 * - per-function measurements (CC, max nesting, SLOC, mass);
 * - per-source-set aggregates (`production` and `test` always separate)
 *   with per-package summed-mass breakdowns;
 * - contract `MetricValue`s, one id per metric per source set
 *   (`complexity.functions.production`, `erosion.eroded-share.test`, …);
 * - ranked `complexity.hotspot` findings with exact paths and line ranges.
 *
 * State rules (SPEC §3.3, §5.1 — documented per metric):
 *
 * - Counts and total mass are always finite (`0` when empty) → `complete`.
 * - Distributions (p50/p90/max CC, max nesting) and the eroded-mass share
 *   are `not-applicable` for a function-free scope (no sample / 0⁄0 ratio).
 * - A scope containing files with parse diagnostics is `incomplete` with
 *   the partial values that could be measured and a reason naming the
 *   count of affected files — `not-applicable` never hides a failure.
 *
 * The analysis never reads files, never re-parses, and never scores: same
 * inventory in ⇒ byte-equal measurement out (SPEC §3.5).
 */
import type { Finding, MetricValue, Range, SourceSet } from "../contract/index.ts";
import {
	classifyLines,
	type FileSyntax,
	type LineKind,
	type SyntaxInventory,
} from "../syntax/index.ts";
import { measureFunctionComplexity } from "./complexity.ts";
import { aggregateMass, ccDistribution, functionMass, isEroded, roundTo } from "./erosion.ts";
import type {
	ComplexityAnalysis,
	FunctionMeasurement,
	PackageAggregate,
	ScopeAggregate,
} from "./types.ts";
import { EROSION_CC_THRESHOLD } from "./types.ts";

/** The source sets complexity measurement covers (SPEC §3.1: scored sets, separately). */
const MEASURED_SETS = ["production", "test"] as const;

/** Code-classified lines within `range` (1-based, inclusive) of one classified file. */
function functionSloc(lines: readonly LineKind[], range: Range): number {
	let sloc = 0;
	const last = Math.min(range.end.line, lines.length);
	for (let line = range.start.line; line <= last; line += 1) {
		if (lines[line - 1] === "code") sloc += 1;
	}
	return sloc;
}

/** Measure every function of one file against its (once-computed) line classification. */
function measureFile(file: FileSyntax): FunctionMeasurement[] {
	if (file.functions.length === 0) return [];
	const lines = classifyLines(file.sourceFile);
	return file.functions.map((fn) => {
		const { cc, maxNesting } = measureFunctionComplexity(fn);
		const sloc = functionSloc(lines, fn.range);
		const mass = functionMass(cc, sloc);
		return {
			path: file.path,
			packagePath: file.packagePath,
			sourceSet: file.sourceSet,
			name: fn.name,
			kind: fn.kind,
			range: fn.range,
			cc,
			maxNesting,
			sloc,
			mass,
			eroded: isEroded(cc),
		};
	});
}

/** Per-package breakdown of one scope, sorted by package path. */
function packageAggregates(
	files: readonly FileSyntax[],
	functions: readonly FunctionMeasurement[],
): PackageAggregate[] {
	const packagePaths = [...new Set(files.map((file) => file.packagePath))].sort();
	return packagePaths.map((packagePath) => {
		const ownedFiles = files.filter((file) => file.packagePath === packagePath);
		const ownedFunctions = functions.filter((fn) => fn.packagePath === packagePath);
		return {
			packagePath,
			...aggregateMass(
				ownedFiles.length,
				ownedFiles.reduce((sum, file) => sum + file.lines.code, 0),
				ownedFunctions,
			),
		};
	});
}

/** Aggregate one source set's files and function measurements into a scope. */
function scopeAggregate(
	sourceSet: SourceSet,
	files: readonly FileSyntax[],
	functions: readonly FunctionMeasurement[],
): ScopeAggregate {
	const aggregate = aggregateMass(
		files.length,
		files.reduce((sum, file) => sum + file.lines.code, 0),
		functions,
	);
	return {
		sourceSet,
		...aggregate,
		diagnosticFiles: files
			.filter((file) => file.diagnostics.length > 0)
			.map((file) => file.path)
			.sort(),
		cc: ccDistribution(functions.map((fn) => fn.cc)),
		maxNesting: functions.length === 0 ? null : Math.max(...functions.map((fn) => fn.maxNesting)),
		packages: packageAggregates(files, functions),
	};
}

/** The reason an incomplete scope could not be fully analyzed (SPEC §3.3). */
function incompleteReason(scope: ScopeAggregate): string | undefined {
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

/** Rounded per-package detail rows for the eroded-share metric. */
function packageDetail(scope: ScopeAggregate): Record<string, unknown>[] {
	return scope.packages.map((pkg) => ({
		packagePath: pkg.packagePath,
		functions: pkg.functionCount,
		mass: roundTo(pkg.mass, 3),
		erodedMass: roundTo(pkg.erodedMass, 3),
		erodedShare: pkg.erodedShare === null ? null : roundTo(pkg.erodedShare, 6),
	}));
}

/** Emit the per-scope metric set: ids carry the source set as their last segment. */
function scopeMetrics(scope: ScopeAggregate): MetricValue[] {
	const set = scope.sourceSet;
	const reason = incompleteReason(scope);
	const share = scope.erodedShare === null ? null : roundTo(scope.erodedShare, 6);
	const metrics: MetricValue[] = [
		metric(`complexity.functions.${set}`, "count", scope.functionCount, reason, {
			detail: { files: scope.files, sloc: scope.sloc },
		}),
		metric(`complexity.cc.p50.${set}`, "cc", scope.cc?.p50 ?? null, reason),
		metric(`complexity.cc.p90.${set}`, "cc", scope.cc?.p90 ?? null, reason),
		metric(`complexity.cc.max.${set}`, "cc", scope.cc?.max ?? null, reason),
		metric(`complexity.nesting.max.${set}`, "depth", scope.maxNesting, reason),
		metric(`erosion.mass.${set}`, "mass", roundTo(scope.mass, 3), reason),
		metric(`erosion.eroded-count.${set}`, "count", scope.erodedCount, reason),
		metric(`erosion.eroded-share.${set}`, "ratio", share, reason, {
			...(scope.mass === 0
				? {}
				: {
						numerator: roundTo(scope.erodedMass, 3),
						denominator: roundTo(scope.mass, 3),
					}),
			detail: { thresholdCc: EROSION_CC_THRESHOLD, packages: packageDetail(scope) },
		}),
	];
	return metrics;
}

/** Deterministic hotspot rank order: mass descending, then path, line, name. */
function byHotspotRank(a: FunctionMeasurement, b: FunctionMeasurement): number {
	if (a.mass !== b.mass) return b.mass - a.mass;
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Ranked `complexity.hotspot` findings for every eroded function (SPEC §5.1, §6.2). */
function hotspotFindings(functions: readonly FunctionMeasurement[]): Finding[] {
	return functions
		.filter((fn) => fn.eroded)
		.sort(byHotspotRank)
		.map((fn, index) => ({
			kind: "complexity.hotspot",
			path: fn.path,
			range: fn.range,
			summary: `CC ${fn.cc}, mass ${roundTo(fn.mass, 3)}, nesting ${fn.maxNesting}, SLOC ${fn.sloc}`,
			facts: {
				rank: index + 1,
				name: fn.name,
				functionKind: fn.kind,
				sourceSet: fn.sourceSet,
				cc: fn.cc,
				maxNesting: fn.maxNesting,
				sloc: fn.sloc,
				mass: roundTo(fn.mass, 3),
			},
		}));
}

/**
 * Measure complexity and structural erosion over the shared syntax
 * inventory (see the module docblock for states and outputs). Pure and
 * synchronous: the inventory already holds every parse.
 */
export function analyzeComplexity(inventory: SyntaxInventory): ComplexityAnalysis {
	const measuredFiles = inventory.files.filter((file) =>
		(MEASURED_SETS as readonly string[]).includes(file.sourceSet),
	);
	const functions = measuredFiles.flatMap((file) => measureFile(file));
	const scopes = {
		production: scopeAggregate(
			"production",
			measuredFiles.filter((file) => file.sourceSet === "production"),
			functions.filter((fn) => fn.sourceSet === "production"),
		),
		test: scopeAggregate(
			"test",
			measuredFiles.filter((file) => file.sourceSet === "test"),
			functions.filter((fn) => fn.sourceSet === "test"),
		),
	};
	const metrics = [...scopeMetrics(scopes.production), ...scopeMetrics(scopes.test)].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return { functions, scopes, metrics, findings: hotspotFindings(functions) };
}
