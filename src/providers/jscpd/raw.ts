/**
 * Raw jscpd report schemas and raw-evidence validation (SPEC §16.4, plan
 * `pl-43c5` — trellis-f4e2, step 12).
 *
 * The pinned jscpd 5.2.1 `json` reporter emits one report per run:
 * `duplicates` (the clone pairs it found) and `statistics` (its own
 * totals). This module types that raw payload **exactly as the pinned tool
 * emits it** — no normalization, no canonicalization, no scoring semantics
 * (group reconstruction, affected-line accounting and namespaced evidence
 * are step 13, trellis-da4c) — and validates it into typed evidence the
 * invocation adapter (`adapter.ts`) can rely on:
 *
 * - **Schema validation.** Strict shapes: unknown or malformed payloads
 *   fail with located, bounded reasons — adapters translate those into
 *   `incomplete` analysis with reasons, never clean results (§16.2).
 * - **Match-kind separation.** The pinned tool reports clone kinds `exact`
 *   (token-identical), `renamed` (identifier/literal normalization) and
 *   `similar` (AST-similarity/gap near misses). Each kind maps onto the
 *   contract's match modes, and each invocation mode produces only its
 *   observed subset — validated, so a kind the mode never produces in the
 *   pinned tool is suspect evidence (empirical basis:
 *   docs/research/jscpd-provider-spike).
 * - **Position validation.** A clone member's `start`/`end` lines must agree
 *   with its `startLoc`/`endLoc` and never invert.
 * - **Source-identity validation.** Every clone references staged paths; a
 *   report naming anything outside the staged selection is unexpected-path
 *   evidence, never a finding.
 */
import { z } from "zod";
import { CLONE_MATCH_MODES, type CloneMatchMode } from "../../contract/index.ts";
import { messageOf } from "../staging.ts";

/** Provider id of the pinned duplication tool (matches the manifest and capabilities). */
export const JSCPD_PROVIDER_ID = "jscpd";

/** Version of this trellis adapter (part of provider identity, SPEC §16.2). */
export const JSCPD_ADAPTER_VERSION = "0.1.0";

/** The provider's own parser identity: jscpd's tokenizing engine (not trellis's TypeScript). */
export const JSCPD_PARSER_ENGINE = "jscpd.tokenizer";

/** Clone kinds the pinned jscpd reports (its own vocabulary — not trellis's match modes). */
export const JSCPD_RAW_MATCH_KINDS = ["exact", "renamed", "similar"] as const;
export type RawJscpdMatchKind = (typeof JSCPD_RAW_MATCH_KINDS)[number];
export const rawJscpdMatchKindSchema = z.enum(JSCPD_RAW_MATCH_KINDS);

/** Which contract match mode one raw kind separates into (exact / normalized / near). */
export const MATCH_MODE_BY_RAW_KIND: Readonly<Record<RawJscpdMatchKind, CloneMatchMode>> = {
	exact: "exact",
	renamed: "normalized",
	similar: "near",
};

/**
 * The raw kinds each invocation mode produces in the pinned tool (observed
 * across the spike corpus: exact mode reports only `exact`; normalization
 * adds `renamed`; near adds `similar`). A kind outside the mode's set means
 * the payload does not match the pinned tool's behavior.
 */
export const RAW_KINDS_BY_MODE: Readonly<Record<CloneMatchMode, readonly RawJscpdMatchKind[]>> = {
	exact: ["exact"],
	normalized: ["exact", "renamed"],
	near: ["exact", "renamed", "similar"],
};

/** Bounded reasons: never echo an unbounded schema failure into evidence. */
const MAX_REASONS = 8;

function capReasons(reasons: readonly string[]): string[] {
	const capped = reasons.slice(0, MAX_REASONS);
	const omitted = reasons.length - capped.length;
	return omitted > 0 ? [...capped, `…and ${omitted} more problems`] : capped;
}

/** One source position inside a cloned fragment, as the pinned tool reports it. */
const rawJscpdLocSchema = z.strictObject({
	column: z.number().int().nonnegative(),
	line: z.number().int().min(1),
	position: z.number().int().nonnegative(),
});

/** One side of a clone pair: the file name plus its located line span. */
const rawJscpdCloneFileSchema = z
	.strictObject({
		name: z.string().min(1),
		start: z.number().int().min(1),
		end: z.number().int().min(1),
		startLoc: rawJscpdLocSchema,
		endLoc: rawJscpdLocSchema,
	})
	.superRefine((file, ctx) => {
		if (file.end < file.start) {
			ctx.addIssue({
				code: "custom",
				message: "clone span end line must not precede its start line",
				path: ["end"],
			});
			return;
		}
		if (file.startLoc.line !== file.start) {
			ctx.addIssue({
				code: "custom",
				message: "startLoc.line must agree with the reported start line",
				path: ["startLoc", "line"],
			});
		}
		if (file.endLoc.line !== file.end) {
			ctx.addIssue({
				code: "custom",
				message: "endLoc.line must agree with the reported end line",
				path: ["endLoc", "line"],
			});
		}
	});
export type RawJscpdCloneFile = z.infer<typeof rawJscpdCloneFileSchema>;

/**
 * One raw clone pair. `method`/`similarity` are near-miss fields: exactly
 * the `similar` kind carries them in the pinned tool, so any other kind
 * carrying them (or a similar clone without them) fails validation.
 */
const rawJscpdCloneSchema = z
	.strictObject({
		firstFile: rawJscpdCloneFileSchema,
		secondFile: rawJscpdCloneFileSchema,
		format: z.string().min(1),
		fragment: z.string(),
		isNew: z.boolean(),
		kind: rawJscpdMatchKindSchema,
		lines: z.number().int().min(1),
		tokens: z.number().int().min(1),
		method: z.string().min(1).optional(),
		similarity: z.number().finite().gt(0).lte(1).optional(),
	})
	.superRefine((clone, ctx) => {
		const hasNearMissFields = clone.method !== undefined || clone.similarity !== undefined;
		if (clone.kind === "similar" && (!clone.method || clone.similarity === undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "a similar clone must carry its method and similarity",
				path: ["kind"],
			});
			return;
		}
		if (clone.kind !== "similar" && hasNearMissFields) {
			ctx.addIssue({
				code: "custom",
				message: "method and similarity are near-miss fields only a similar clone carries",
				path: ["method"],
			});
		}
	});
export type RawJscpdClone = z.infer<typeof rawJscpdCloneSchema>;

/** jscpd's per-format (and total) accounting, in its own units. */
const rawJscpdFormatStatisticsSchema = z.strictObject({
	clones: z.number().int().nonnegative(),
	duplicatedLines: z.number().int().nonnegative(),
	duplicatedTokens: z.number().int().nonnegative(),
	lines: z.number().int().nonnegative(),
	newClones: z.number().int().nonnegative(),
	newDuplicatedLines: z.number().int().nonnegative(),
	percentage: z.number().finite().nonnegative(),
	percentageTokens: z.number().finite().nonnegative(),
	sources: z.number().int().nonnegative(),
	tokens: z.number().int().nonnegative(),
});
export type RawJscpdFormatStatistics = z.infer<typeof rawJscpdFormatStatisticsSchema>;

/**
 * Raw statistics. `detectionDate` is the tool's own volatile timestamp —
 * recorded here because the raw payload records it, excluded downstream
 * (identity never carries it; step 13 owns canonicalizing it away).
 * `total.sources` counts only files at/above the token threshold — never
 * confused with selected or analyzed coverage (adapter's coverage account).
 */
const rawJscpdStatisticsSchema = z.strictObject({
	detectionDate: z.string().min(1),
	formats: z.record(z.string().min(1), rawJscpdFormatStatisticsSchema),
	total: rawJscpdFormatStatisticsSchema,
});
export type RawJscpdStatistics = z.infer<typeof rawJscpdStatisticsSchema>;

/** The raw report: its totals must account for every duplicate it lists. */
export const rawJscpdReportSchema = z
	.strictObject({
		duplicates: z.array(rawJscpdCloneSchema),
		statistics: rawJscpdStatisticsSchema,
	})
	.superRefine((report, ctx) => {
		if (report.statistics.total.clones !== report.duplicates.length) {
			ctx.addIssue({
				code: "custom",
				message: `statistics.total.clones (${report.statistics.total.clones}) must equal the number of reported duplicates (${report.duplicates.length})`,
				path: ["statistics", "total", "clones"],
			});
		}
	});
export type RawJscpdReport = z.infer<typeof rawJscpdReportSchema>;

/** Outcome of parsing a raw report text into typed evidence. */
export type RawJscpdParse = { ok: true; report: RawJscpdReport } | { ok: false; reasons: string[] };

/**
 * Parse and schema-validate one raw jscpd report text. Malformed or
 * truncated JSON and unknown payloads fail with located, bounded reasons —
 * the caller turns those into `incomplete` analysis, never clean evidence.
 */
export function parseRawJscpdReport(text: string): RawJscpdParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, reasons: [`raw jscpd report is not valid JSON: ${messageOf(error)}`] };
	}
	const result = rawJscpdReportSchema.safeParse(parsed);
	if (result.success) {
		return { ok: true, report: result.data };
	}
	const reasons = capReasons(
		result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
	);
	return { ok: false, reasons };
}

/** Normalize a reported clone file name to a POSIX repo-relative candidate. */
function normalizeCloneName(name: string): string {
	return name.replaceAll("\\", "/");
}

/**
 * Validate a schema-valid raw report against the staged selection and the
 * invocation mode: every clone must reference staged files (unexpected
 * paths are suspect evidence), report only kinds the mode produces, and
 * account for no more sources than files exist. Returns the (possibly
 * empty) list of reasons; an empty list means the evidence is sound.
 */
export function validateRawJscpdEvidence(
	report: RawJscpdReport,
	selectionPaths: ReadonlySet<string>,
	mode: CloneMatchMode,
): string[] {
	const allowedKinds = new Set(RAW_KINDS_BY_MODE[mode]);
	const reasons: string[] = [];
	for (const [index, clone] of report.duplicates.entries()) {
		for (const side of ["firstFile", "secondFile"] as const) {
			const name = normalizeCloneName(clone[side].name);
			if (!selectionPaths.has(name)) {
				reasons.push(
					`duplicate #${index} (${side}) references "${name}", which is outside the staged selection`,
				);
			}
		}
		if (!allowedKinds.has(clone.kind)) {
			reasons.push(
				`duplicate #${index} reports kind "${clone.kind}", which the "${mode}" mode never produces in the pinned tool`,
			);
		}
	}
	if (report.statistics.total.sources > selectionPaths.size) {
		reasons.push(
			`statistics.total.sources (${report.statistics.total.sources}) exceeds the staged selection (${selectionPaths.size} files)`,
		);
	}
	return capReasons(reasons);
}

/** The contract match modes this adapter executes, in canonical order. */
export const JSCPD_MATCH_MODES: readonly CloneMatchMode[] = CLONE_MATCH_MODES;
