import { describe, expect, test } from "bun:test";
import type { DriftReport } from "./drift.ts";
import { renderDriftMarkdown, renderDriftTerminal } from "./drift-report.ts";

/** A synthetic drift report exercising every state and note shape. */
const REPORT: DriftReport = {
	repo: "warren",
	canonicalVersion: "1.0.0",
	files: [
		{
			path: "biome.json",
			matcher: "json-subset",
			version: "1.0.0",
			state: "match",
			divergences: [],
			allowedBy: [],
		},
		{
			path: "tsconfig.base.json",
			matcher: "json-subset",
			version: "1.0.0",
			state: "extra",
			divergences: [{ path: "include", kind: "added", detail: "target-only key" }],
			allowedBy: [],
		},
		{
			path: ".github/workflows/ci.yml",
			matcher: "text",
			version: "1.0.0",
			state: "drift",
			divergences: [
				{ path: "", kind: "changed", detail: "normalized text differs from canonical" },
			],
			allowedBy: [],
		},
		{
			path: "scripts/hooks/pre-commit",
			matcher: "exact",
			version: "1.0.0",
			state: "missing",
			divergences: [],
			allowedBy: [],
		},
		{
			path: "AGENTS.md",
			matcher: "template",
			version: "1.0.0",
			state: "allowed-delta",
			divergences: [
				{ path: "section:conventions", kind: "missing", detail: "required section absent" },
			],
			allowedBy: [
				{ file: "AGENTS.md", paths: ["section:conventions"], reason: "merged into README" },
			],
		},
	],
	summary: { match: 1, "allowed-delta": 1, drift: 1, missing: 1, extra: 1 },
};

describe("renderDriftTerminal", () => {
	const out = renderDriftTerminal(REPORT);

	test("headlines the repo and canonical version", () => {
		expect(out).toContain("warren");
		expect(out).toContain("canonical 1.0.0");
	});

	test("lists every file path", () => {
		for (const file of REPORT.files) expect(out).toContain(file.path);
	});

	test("surfaces drift divergence detail and allowed-delta reason", () => {
		expect(out).toContain("normalized text differs from canonical");
		expect(out).toContain("merged into README");
	});

	test("renders the summary line with every state count", () => {
		expect(out).toContain("match 1");
		expect(out).toContain("drift 1");
		expect(out).toContain("missing 1");
		expect(out).toContain("extra 1");
		expect(out).toContain("allowed 1");
	});
});

describe("renderDriftMarkdown", () => {
	const out = renderDriftMarkdown(REPORT);

	test("renders a table header and a row per file", () => {
		expect(out).toContain("| File | State | Matcher | Note |");
		for (const file of REPORT.files) expect(out).toContain(`\`${file.path}\``);
	});

	test("escapes pipes inside notes", () => {
		const piped: DriftReport = {
			...REPORT,
			files: [
				{
					path: "x.json",
					matcher: "json-subset",
					version: "1.0.0",
					state: "drift",
					divergences: [{ path: "a", kind: "changed", detail: "has | pipe" }],
					allowedBy: [],
				},
			],
		};
		expect(renderDriftMarkdown(piped)).toContain("has \\| pipe");
	});
});
