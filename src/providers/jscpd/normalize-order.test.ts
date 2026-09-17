import { describe, expect, test } from "bun:test";
import { cloneEvidenceSchema } from "../../contract/index.ts";
import { accountedFiles, reportOf, TOTAL_FUNCTION } from "./normalize.fixtures.ts";
import { normalizeJscpdReport } from "./normalize.ts";
import type { RawJscpdClone } from "./raw.ts";

/**
 * Contract-order regression for jscpd group members (found by the step-15
 * audit integration over a real workspace): the pinned tool's end columns on
 * multiline matches are approximate, so two records of one
 * content-identical class can name the same member location (path, start
 * line/column, end line) with different end columns. The versioned
 * clone-evidence contract treats those as ONE member — the deterministic
 * first survives (smallest end column), the group validates against the
 * schema, and every contributing record stays visible in the raw facts.
 */
describe("normalizeJscpdReport member order", () => {
	test("collapses group members the tool reports at one location with different end columns", () => {
		// The pinned tool's end columns on multiline matches are approximate:
		// two records of one content-identical class can name the same member
		// location (path, start line/column, end line) with different end
		// columns. The contract's location order treats those as ONE member —
		// the deterministic first survives (smallest end column), the group
		// validates against the versioned clone-evidence schema, and the
		// class's raw facts keep every contributing record visible.
		const at = (
			path: string,
			startLine: number,
			endLine: number,
			startColumn: number,
			endColumn: number,
		) => ({
			path,
			range: {
				start: { line: startLine, column: startColumn },
				end: { line: endLine, column: endColumn },
			},
		});
		const member = (location: ReturnType<typeof at>) => ({
			name: location.path,
			start: location.range.start.line,
			end: location.range.end.line,
			startLoc: {
				column: location.range.start.column - 1,
				line: location.range.start.line,
				position: 0,
			},
			endLoc: { column: location.range.end.column - 1, line: location.range.end.line, position: 0 },
		});
		const rawRecord = (
			first: ReturnType<typeof at>,
			second: ReturnType<typeof at>,
		): RawJscpdClone => ({
			firstFile: member(first),
			secondFile: member(second),
			format: "typescript",
			fragment: "identical fragment",
			isNew: false,
			kind: "renamed",
			lines: first.range.end.line - first.range.start.line + 1,
			tokens: 88,
		});
		const report = reportOf([
			rawRecord(at("a.ts", 64, 76, 51, 16), at("b.ts", 5, 17, 1, 30)),
			rawRecord(at("a.ts", 64, 76, 51, 71), at("c.ts", 9, 21, 1, 30)),
		]);
		const normalized = normalizeJscpdReport(
			report,
			accountedFiles({ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION, "c.ts": TOTAL_FUNCTION }),
		);
		expect(normalized.cloneEvidence).toEqual([
			{
				kind: "group",
				matchMode: "normalized",
				members: [at("a.ts", 64, 76, 51, 16), at("b.ts", 5, 17, 1, 30), at("c.ts", 9, 21, 1, 30)],
			},
		]);
		for (const entry of normalized.cloneEvidence) {
			expect(cloneEvidenceSchema.parse(entry)).toEqual(entry);
		}
		// Every contributing record stays visible on the finding's raw facts.
		const groupFinding = normalized.findings.find((finding) =>
			finding.kind.endsWith("clone-group"),
		);
		expect(groupFinding?.facts).toMatchObject({ memberCount: 3, rawKinds: ["renamed"] });
	});
});
