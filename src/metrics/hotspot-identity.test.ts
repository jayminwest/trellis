import { afterEach, describe, expect, test } from "bun:test";
import { auditReportSchema } from "../contract/index.ts";
import { auditFixture, type FixtureReport } from "../report/audit-fixtures.ts";
import { collectFunctions } from "../syntax/functions.ts";
import { parseSource } from "../syntax/parse.ts";
import type { FileSyntax, SyntaxInventory } from "../syntax/types.ts";
import { analyzeComplexity } from "./analyze.ts";

let fixture: FixtureReport | undefined;
afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

const HOT_BODY = Array.from({ length: 11 }, (_, i) => `if (n === ${i}) return ${i};`).join("\n");
function inventory(text: string): SyntaxInventory {
	const parsed = parseSource("a.ts", text);
	const functions = collectFunctions(parsed.sourceFile);
	const file: FileSyntax = {
		path: "a.ts",
		packagePath: ".",
		sourceSet: "production",
		scriptKind: "ts",
		sourceFile: parsed.sourceFile,
		...functions,
		lines: { code: 13, blank: 0, commentOnly: 0, total: 13 },
		diagnostics: [],
	};
	return {
		root: "/fixture",
		compilerVersion: "test",
		files: [file],
		functionCount: functions.functions.length,
		diagnostics: [],
		completeness: "complete",
	};
}

describe("hotspot identity emission", () => {
	test("carries file source set and identity while retaining every hotspot and raw metric", () => {
		const syntax = inventory(`function alpha(n) {\n${HOT_BODY}\n}`);
		const result = analyzeComplexity(syntax);
		expect(result.findings[0]?.identity).toMatchObject({
			state: "identified",
			sourceSet: "production",
			function: { name: "alpha" },
		});
		const changed = inventory(`function beta(n) {\n${HOT_BODY}\n}`);
		expect(analyzeComplexity(changed).metrics).toEqual(result.metrics);
		const testFile = syntax.files[0];
		if (testFile === undefined) throw new Error("missing file");
		testFile.sourceSet = "test";
		expect(analyzeComplexity(syntax).findings[0]?.identity).toMatchObject({ sourceSet: "test" });
	});

	test("marks a hotspot ambiguous when its duplicate is below the hotspot threshold", () => {
		const syntax = inventory(`function alpha(n) {\n${HOT_BODY}\n} function alpha() {}`);
		const result = analyzeComplexity(syntax);
		expect(result.functions).toHaveLength(2);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.identity).toEqual({
			version: "1.0.0",
			state: "ambiguous",
			reason: "duplicate",
		});
	});

	test("round-trips modern findings and rejects missing, malformed or unknown identity", async () => {
		fixture = await auditFixture("sloppy");
		const { report } = fixture;
		expect(report.schemaVersion).toBe("1.2.0");
		if (report.schemaVersion === "1.0.0") throw new Error("expected modern report");
		expect(auditReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
		const hotspot = report.findings.find((finding) => finding.kind === "complexity.hotspot");
		if (hotspot === undefined) throw new Error("missing hotspot");
		for (const identity of [
			undefined,
			{ ...hotspot.identity, version: "99.0.0" },
			{ state: "identified" },
		]) {
			const invalid = {
				...report,
				findings: report.findings.map((finding) =>
					finding === hotspot ? { ...finding, identity } : finding,
				),
			};
			expect(auditReportSchema.safeParse(invalid).success).toBe(false);
		}
	});
});
