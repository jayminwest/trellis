/**
 * Raw dependency-cruiser report schemas and raw-evidence validation (SPEC
 * §16.4, plan `pl-43c5` step 22 — trellis-adbf).
 *
 * The pinned dependency-cruiser `--output-type json` reporter emits one
 * graph per run: `modules` (every module it cruised — staged production
 * modules plus stub nodes for builtins, externals and unresolvable imports)
 * and `summary` (its own violation accounting). This module types that raw
 * payload **exactly as the pinned tool emits it** for the parts the adapter
 * consumes — no normalization, no scoring semantics (normalization is
 * `./normalize.ts`) — and validates it into typed evidence the cruise run
 * (`./cruise-run.ts`) can rely on:
 *
 * - **Schema validation.** The modules, dependencies and violations the
 *   adapter consumes carry strict shapes; unknown or malformed payloads
 *   fail with located, bounded reasons — the run turns those into
 *   `incomplete` analysis, never a clean result (§16.2).
 * - **Volatile fields excluded by construction.** The pinned tool's
 *   `summary` also carries `optionsUsed`, `ruleSetUsed` and `environment`
 *   — machine paths and run-time environment records. They never become
 *   typed evidence (they are stripped at parse), so they can never enter
 *   analysis identity (§16.2, AC1) or a report.
 * - **Own-vocabulary validation.** `dependencyTypes` and `moduleSystem`
 *   are the tool's open-ended vocabulary — typed as bounded non-empty
 *   strings and validated per-run against what the generated
 *   configuration can produce (every violation names a compiled rule and
 *   a staged module), so a drifted or foreign report is suspect evidence,
 *   never a finding (§16.2).
 */
import { z } from "zod";
import { messageOf } from "../staging.ts";

/** Provider id of the pinned architecture tool (manifest + capabilities). */
export const DEPENDENCY_CRUISER_PROVIDER_ID = "dependency-cruiser";

/** Version of this trellis adapter (part of provider identity, SPEC §16.2). */
export const DEPENDENCY_CRUISER_ADAPTER_VERSION = "0.1.0";

/**
 * The parser identity of the pinned tool's engine: dependency-cruiser
 * reads TypeScript through the TypeScript compiler it resolves locally —
 * never trellis's own pinned compiler (the research record: a mismatched
 * or missing parser produced a successful empty graph). The resolved
 * version rides the analysis identity (`./invocation.ts`).
 */
export const DEPENDENCY_CRUISER_PARSER_ENGINE = "dependency-cruiser.typescript";

/** The invocation mode the adapter runs (the contracted capability, §16.1). */
export const DEPENDENCY_CRUISER_MODE = "declared-rules";

/** Bounded reasons: never echo an unbounded schema failure into evidence. */
const MAX_REASONS = 8;

function capReasons(reasons: readonly string[]): string[] {
	const capped = reasons.slice(0, MAX_REASONS);
	const omitted = reasons.length - capped.length;
	return omitted > 0 ? [...capped, `…and ${omitted} more problems`] : capped;
}

/** The tool's violation types its own rule vocabulary can produce (the generated config never emits the rest). */
const RAW_VIOLATION_TYPES = ["dependency", "cycle"] as const;
const rawViolationTypeSchema = z.enum(RAW_VIOLATION_TYPES);

/** The tool's severities; the adapter generates `error` rules only, but types what the tool reports. */
const rawSeveritySchema = z.enum(["error", "warn", "info", "ignore"]);

/** One member of a reported cycle path, in the tool's own vocabulary. */
const rawCycleMemberSchema = z.strictObject({
	name: z.string().min(1),
	dependencyTypes: z.array(z.string().min(1)).min(1),
});
export type RawCycleMember = z.infer<typeof rawCycleMemberSchema>;

/** One reported rule violation. `unresolvedTo` carries the raw specifier. */
export const rawViolationSchema = z
	.strictObject({
		type: rawViolationTypeSchema,
		rule: z.strictObject({ severity: rawSeveritySchema, name: z.string().min(1) }),
		from: z.string().min(1),
		to: z.string().min(1),
		unresolvedTo: z.string().min(1).optional(),
		dependencyTypes: z.array(z.string().min(1)).min(1),
		cycle: z.array(rawCycleMemberSchema).optional(),
	})
	.superRefine((violation, ctx) => {
		if (violation.type === "cycle" && violation.cycle === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "a cycle violation carries its cycle path",
				path: ["cycle"],
			});
		}
	});
export type RawViolation = z.infer<typeof rawViolationSchema>;

/** One reported dependency edge, in the tool's own vocabulary. */
export const rawDependencySchema = z.strictObject({
	module: z.string().min(1),
	resolved: z.string().min(1),
	moduleSystem: z.string().min(1),
	dependencyTypes: z.array(z.string().min(1)).min(1),
	dynamic: z.boolean(),
	coreModule: z.boolean(),
	followable: z.boolean(),
	couldNotResolve: z.boolean(),
	matchesDoNotFollow: z.boolean(),
	exoticallyRequired: z.boolean(),
	circular: z.boolean(),
	valid: z.boolean(),
	/** Protocol-specifier imports (`node:`, `data:`, `file:`) carry their protocol; plain specifiers omit it. */
	protocol: z.string().min(1).optional(),
	mimeType: z.string().min(1).optional(),
	cycle: z.array(rawCycleMemberSchema).optional(),
	rules: z
		.array(z.strictObject({ severity: rawSeveritySchema, name: z.string().min(1) }))
		.optional(),
});
export type RawDependency = z.infer<typeof rawDependencySchema>;

/** One cruised module. Stub nodes additionally carry their own classification fields. */
export const rawModuleSchema = z.strictObject({
	source: z.string().min(1),
	dependencies: z.array(rawDependencySchema),
	dependents: z.array(z.string().min(1)),
	orphan: z.boolean(),
	valid: z.boolean(),
	coreModule: z.boolean().optional(),
	couldNotResolve: z.boolean().optional(),
	followable: z.boolean().optional(),
	matchesDoNotFollow: z.boolean().optional(),
	dependencyTypes: z.array(z.string().min(1)).optional(),
});
export type RawModule = z.infer<typeof rawModuleSchema>;

/**
 * The raw report. `summary` is validated on the fields the adapter
 * consumes and strips the rest — the pinned tool's own machine-context
 * records (`optionsUsed`, `ruleSetUsed`, `environment`) are dropped, never
 * typed, never carried downstream.
 */
export const rawDependencyCruiserReportSchema = z.strictObject({
	modules: z.array(rawModuleSchema),
	summary: z
		.object({
			violations: z.array(rawViolationSchema),
			error: z.number().int().nonnegative(),
			warn: z.number().int().nonnegative(),
			info: z.number().int().nonnegative(),
			ignore: z.number().int().nonnegative(),
			totalCruised: z.number().int().nonnegative(),
			totalDependenciesCruised: z.number().int().nonnegative(),
		})
		.superRefine((summary, ctx) => {
			if (
				summary.error + summary.warn + summary.info + summary.ignore <
				summary.violations.length
			) {
				ctx.addIssue({
					code: "custom",
					message:
						"the severity totals must account for every reported violation — the report contradicts itself",
					path: ["error"],
				});
			}
		}),
});
export type RawDependencyCruiserReport = z.infer<typeof rawDependencyCruiserReportSchema>;

/** Outcome of parsing a raw report text into typed evidence. */
export type RawDependencyCruiserParse =
	| { ok: true; report: RawDependencyCruiserReport }
	| { ok: false; reasons: string[] };

/**
 * Parse and schema-validate one raw dependency-cruiser report text.
 * Malformed or truncated JSON and unknown payloads fail with located,
 * bounded reasons — the caller turns those into `incomplete` analysis,
 * never clean evidence.
 */
export function parseRawDependencyCruiserReport(text: string): RawDependencyCruiserParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			reasons: [`raw dependency-cruiser report is not valid JSON: ${messageOf(error)}`],
		};
	}
	const result = rawDependencyCruiserReportSchema.safeParse(parsed);
	if (result.success) {
		return { ok: true, report: result.data };
	}
	return {
		ok: false,
		reasons: capReasons(
			result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
		),
	};
}

/**
 * Validate a schema-valid raw report against the staged selection and the
 * generated configuration's own rule names: every violation must name a
 * compiled rule (a foreign rule means a foreign configuration leaked into
 * the run) and originate in a staged module (a violation outside the staged
 * scope is suspect evidence, never a finding), and module sources must be
 * unique. Returns the (possibly empty) list of reasons; an empty list means
 * the evidence is sound.
 */
export function validateRawDependencyCruiserEvidence(
	report: RawDependencyCruiserReport,
	selectionPaths: ReadonlySet<string>,
	ruleNames: ReadonlySet<string>,
): string[] {
	const reasons: string[] = [];
	const sources = new Set<string>();
	for (const module of report.modules) {
		if (sources.has(module.source)) {
			reasons.push(`module "${module.source}" is reported twice — the graph is not a graph`);
		}
		sources.add(module.source);
	}
	for (const [index, violation] of report.summary.violations.entries()) {
		if (!ruleNames.has(violation.rule.name)) {
			reasons.push(
				`violation #${index} names rule "${violation.rule.name}", which the compiled policy does not declare`,
			);
		}
		if (!selectionPaths.has(violation.from)) {
			reasons.push(
				`violation #${index} originates in "${violation.from}", which is outside the staged selection`,
			);
		}
	}
	return capReasons(reasons);
}
