/**
 * Shared fixtures for the jscpd normalization tests (trellis-da4c, step 13).
 *
 * Two input families, both real: the research spike's labeled source
 * fixtures (byte-identical / renamed / near pairs — the same inputs the
 * pinned tool's checked-in raw reports were produced from) and its raw
 * report artifacts; plus typed builders that author schema-valid raw
 * reports through `parseRawJscpdReport`, so authored test inputs pass the
 * exact validation boundary the pipeline enforces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JscpdAccountedFile } from "./lines.ts";
import {
	parseRawJscpdReport,
	type RawJscpdClone,
	type RawJscpdCloneFile,
	type RawJscpdMatchKind,
	type RawJscpdReport,
} from "./raw.ts";

/** The research spike's checked-in inputs and raw reports. */
const SPIKE = join(import.meta.dir, "../../../docs/research/jscpd-provider-spike");

/** The labeled source fixtures, keyed by case name (`exact`, `renamed`, …). */
const FIXTURES: Record<string, Record<string, string>> = Object.fromEntries(
	(
		JSON.parse(readFileSync(join(SPIKE, "fixtures.json"), "utf8")) as {
			name: string;
			files: Record<string, string>;
		}[]
	).map((fixture) => [fixture.name, fixture.files]),
);

/** The labeled fixture texts of one case (fails fast on an unknown case). */
export function fixtureTexts(caseName: string): Record<string, string> {
	const files = FIXTURES[caseName];
	if (files === undefined) {
		throw new Error(`unknown spike fixture case "${caseName}"`);
	}
	return files;
}

/** Parse a real spike report artifact into typed raw evidence. */
export function spikeReport(name: string): RawJscpdReport {
	const parsed = parseRawJscpdReport(readFileSync(join(SPIKE, name), "utf8"));
	if (!parsed.ok) {
		throw new Error(`spike artifact ${name} should parse: ${parsed.reasons.join("; ")}`);
	}
	return parsed.report;
}

/** One reported clone side: lines plus agreeing located positions. */
function side(name: string, start: number, end: number): RawJscpdCloneFile {
	return {
		name,
		start,
		end,
		startLoc: { column: 0, line: start, position: 0 },
		endLoc: { column: 1, line: end, position: 0 },
	};
}

/** Author one raw record; near-miss fields attach only to `similar` kinds. */
export function record(input: {
	first: { name: string; start: number; end: number };
	second: { name: string; start: number; end: number };
	kind: RawJscpdMatchKind;
	fragment: string;
	lines?: number;
	tokens?: number;
	similarity?: number;
}): RawJscpdClone {
	return {
		firstFile: side(input.first.name, input.first.start, input.first.end),
		secondFile: side(input.second.name, input.second.start, input.second.end),
		format: "typescript",
		fragment: input.fragment,
		isNew: false,
		kind: input.kind,
		lines: input.lines ?? input.first.end - input.first.start + 1,
		tokens: input.tokens ?? 88,
		...(input.kind === "similar" ? { method: "ast", similarity: input.similarity ?? 0.86 } : {}),
	};
}

/** Build a schema-valid raw report from authored records (statistics reconciled). */
export function reportOf(duplicates: RawJscpdClone[]): RawJscpdReport {
	const names = new Set(
		duplicates.flatMap((clone) => [clone.firstFile.name, clone.secondFile.name]),
	);
	const total = {
		clones: duplicates.length,
		duplicatedLines: 0,
		duplicatedTokens: 0,
		lines: 0,
		newClones: 0,
		newDuplicatedLines: 0,
		percentage: 0,
		percentageTokens: 0,
		sources: names.size,
		tokens: 0,
	};
	const parsed = parseRawJscpdReport(
		JSON.stringify({
			duplicates,
			statistics: { detectionDate: "2026-01-01T00:00:00.000Z", formats: {}, total },
		}),
	);
	if (!parsed.ok) {
		throw new Error(`authored report should parse: ${parsed.reasons.join("; ")}`);
	}
	return parsed.report;
}

/** The identical 14-line fixture text (every line is a code line). */
export const TOTAL_FUNCTION = fixtureTexts("exact")["a.ts"] ?? "";

/** Accounted production files for the given texts. */
export function accountedFiles(
	entries: Record<string, string>,
	sourceSet: "production" | "test" = "production",
): JscpdAccountedFile[] {
	return Object.entries(entries).map(([path, text]) => ({ path, sourceSet, text }));
}
