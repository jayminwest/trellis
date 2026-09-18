/**
 * Raw Knip report schemas and raw-evidence validation (SPEC §16.4, plan
 * `pl-43c5` step 24 — trellis-8ebc).
 *
 * The pinned Knip runs with `--reporter json --include
 * files,exports,types,unresolved` over a staged source view, so its raw
 * payload is one row per issue-carrying file with the four declared
 * candidate categories (the research record's exact categories:
 * docs/research/architecture-provider-spike). This module types that payload
 * **exactly as the pinned tool emits it** — no normalization, no scoring
 * semantics (normalization is `./normalize.ts`) — and validates it into
 * typed evidence the reachability run (`./knip-run.ts`) can rely on:
 *
 * - **Schema validation.** Rows, candidate records and positions carry
 *   strict shapes; unknown or malformed payloads fail with located, bounded
 *   reasons — the run turns those into `incomplete` analysis, never a clean
 *   result (§16.2). A row carrying any foreign category key (a report from
 *   a different `--include` set) fails the strict object.
 * - **Volatile fields excluded by construction.** The pinned reporter emits
 *   nothing but the issue rows; `--no-progress` keeps stdout pure JSON and
 *   inline ignore directives inside the staged (measured) content remain
 *   author claims in the audited bytes — never adapter-invented facts.
 * - **Ordering is not trusted.** The research record caught nondeterministic
 *   file-row ordering between repeat runs; the raw report preserves the
 *   tool's own order untouched, and normalization — never this module —
 *   owns the stable path/symbol sort.
 */
import { z } from "zod";
import { messageOf } from "../staging.ts";

/** Provider id of the pinned reachability tool (manifest + capabilities). */
export const KNIP_PROVIDER_ID = "knip";

/** Version of this trellis adapter (part of provider identity, SPEC §16.2). */
export const KNIP_ADAPTER_VERSION = "0.1.0";

/**
 * The parser identity of the pinned tool's engine: Knip reads source
 * through its own bundled `oxc-parser` — never trellis's pinned TypeScript
 * compiler (the research record: "Knip uses its own installed analysis
 * stack"). The resolved version rides the analysis identity
 * (`./invocation.ts`), so two installs with a drifted parser never compare
 * equal (§16.6).
 */
export const KNIP_PARSER_ENGINE = "knip.oxc-parser";

/** The invocation mode the adapter runs (the contracted capability, §16.1). */
export const KNIP_MODE = "contextual";

/** The declared candidate categories the fixed `--include` set reports. */
export const KNIP_CANDIDATE_CATEGORIES = ["file", "export", "type", "unresolved"] as const;
export type KnipCandidateCategory = (typeof KNIP_CANDIDATE_CATEGORIES)[number];

/** The fixed `--include` value of the pinned invocation (recorded in identity, §16.2). */
export const KNIP_INCLUDE = "files,exports,types,unresolved";

/** Bounded reasons: never echo an unbounded schema failure into evidence. */
const MAX_REASONS = 8;

function capReasons(reasons: readonly string[]): string[] {
	const capped = reasons.slice(0, MAX_REASONS);
	const omitted = reasons.length - capped.length;
	return omitted > 0 ? [...capped, `…and ${omitted} more problems`] : capped;
}

/**
 * One located symbol record (an unused export/type, or an unresolved
 * specifier). The pinned reporter carries `namespace` — the parent symbol —
 * for members reported inside a declared namespace (the real-workspace
 * record; the tool's `convert` emits it whenever a parent symbol exists).
 */
const rawSymbolSchema = z.strictObject({
	name: z.string().min(1),
	namespace: z.string().min(1).optional(),
	line: z.number().int().min(1),
	col: z.number().int().min(1),
	pos: z.number().int().nonnegative(),
});
export type RawKnipSymbol = z.infer<typeof rawSymbolSchema>;

/** One unused-file record: the tool names the orphan file itself. */
const rawFileSchema = z.strictObject({
	name: z.string().min(1),
});
export type RawKnipFile = z.infer<typeof rawFileSchema>;

/**
 * One reported row: a file plus its per-category records. Every category
 * key is always present (the pinned reporter initializes all reported
 * types), and unknown keys are rejected — a foreign payload is suspect
 * evidence, never a finding.
 */
export const rawKnipRowSchema = z.strictObject({
	file: z.string().min(1),
	exports: z.array(rawSymbolSchema),
	files: z.array(rawFileSchema),
	types: z.array(rawSymbolSchema),
	unresolved: z.array(rawSymbolSchema),
});
export type RawKnipRow = z.infer<typeof rawKnipRowSchema>;

/** The raw report: the pinned JSON reporter's complete output shape. */
export const rawKnipReportSchema = z.strictObject({
	issues: z.array(rawKnipRowSchema),
});
export type RawKnipReport = z.infer<typeof rawKnipReportSchema>;

/** Outcome of parsing a raw report text into typed evidence. */
export type RawKnipParse = { ok: true; report: RawKnipReport } | { ok: false; reasons: string[] };

/**
 * Parse and schema-validate one raw Knip report text. Malformed or
 * truncated JSON and unknown payloads fail with located, bounded reasons —
 * the caller turns those into `incomplete` analysis, never clean evidence.
 */
export function parseRawKnipReport(text: string): RawKnipParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, reasons: [`raw knip report is not valid JSON: ${messageOf(error)}`] };
	}
	const result = rawKnipReportSchema.safeParse(parsed);
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

/** The suspect reasons one report row carries on its own (bounded by the caller). */
function rowReasons(
	row: RawKnipReport["issues"][number],
	index: number,
	selectionPaths: ReadonlySet<string>,
	rows: Set<string>,
): string[] {
	const reasons: string[] = [];
	if (rows.has(row.file)) {
		reasons.push(`row #${index} repeats file "${row.file}" — the report is not one row per file`);
	}
	rows.add(row.file);
	if (!selectionPaths.has(row.file)) {
		reasons.push(`row #${index} names file "${row.file}", which is outside the staged selection`);
		return reasons;
	}
	for (const file of row.files) {
		if (file.name !== row.file) {
			reasons.push(
				`row #${index} carries an orphan record for "${file.name}", which is not the row's own file`,
			);
		}
	}
	for (const [category, records] of [
		["exports", row.exports],
		["types", row.types],
		["unresolved", row.unresolved],
	] as const) {
		const seen = new Set<string>();
		for (const record of records) {
			if (seen.has(record.name)) {
				reasons.push(
					`row #${index} reports ${category} record "${record.name}" twice — the report ` +
						"contradicts itself",
				);
			}
			seen.add(record.name);
		}
	}
	return reasons;
}

/**
 * Validate a schema-valid raw report against the staged selection: every
 * row must name a staged file (a foreign path is suspect evidence, never a
 * finding), an orphan record must name its own row's file (the tool's own
 * invariant), rows must be unique, and symbol records must not repeat a
 * name within a category of one row. Returns the (possibly empty) list of
 * reasons; an empty list means the evidence is sound.
 */
export function validateRawKnipEvidence(
	report: RawKnipReport,
	selectionPaths: ReadonlySet<string>,
): string[] {
	const reasons: string[] = [];
	const rows = new Set<string>();
	for (const [index, row] of report.issues.entries()) {
		reasons.push(...rowReasons(row, index, selectionPaths, rows));
	}
	return capReasons(reasons);
}
