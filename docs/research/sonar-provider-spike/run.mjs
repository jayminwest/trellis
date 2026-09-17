import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";
import { discoverSourceInventory } from "../../../src/discovery/index.ts";
import { parseSource, collectFunctions } from "../../../src/syntax/index.ts";
import { measureFunctionComplexity } from "../../../src/metrics/complexity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const providerRoot = process.env.TRELLIS_SONAR_TOOLS ?? "/tmp/trellis-sonar-tools";
const requireProvider = createRequire(join(providerRoot, "package.json"));
const { Linter } = requireProvider("eslint");
const sonar = requireProvider("eslint-plugin-sonarjs");
const parser = requireProvider("@typescript-eslint/parser");
const providerManifest = JSON.parse(await readFile(join(here, "provider-package.json"), "utf8"));
for (const [name, expected] of Object.entries(providerManifest.dependencies)) {
	assert.equal(
		requireProvider(`${name}/package.json`).version,
		expected,
		`provider version: ${name}`,
	);
}
const rules = {
	"sonarjs/cognitive-complexity": ["error", 0],
	"sonarjs/no-identical-expressions": "error",
	"sonarjs/no-identical-conditions": "error",
	"sonarjs/no-element-overwrite": "error",
};
const linter = new Linter({ configType: "flat" });
const config = [
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser,
			ecmaVersion: 2022,
			sourceType: "module",
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		plugins: { sonarjs: sonar },
		rules,
		linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
	},
];
const hash = (text) => createHash("sha256").update(text).digest("hex");
const fixtures = JSON.parse(await readFile(join(here, "fixtures.json"), "utf8"));
const discovery = await discoverSourceInventory(root);
const production = await Promise.all(
	discovery.files
		.filter((f) => f.sourceSet === "production" && /^(src|scripts)\//.test(f.path))
		.map(async (f) => ({ path: f.path, source: await readFile(join(root, f.path), "utf8") })),
);
const inputs = [
	...production,
	...fixtures.map((f) => ({ path: `fixtures/${f.name}.ts`, source: f.source })),
];
function analyze(input) {
	const messages = linter
		.verify(input.source, config, { filename: input.path })
		.map((m) => ({
			rule: m.ruleId,
			message: m.message,
			messageId: m.messageId ?? null,
			severity: m.severity,
			fatal: m.fatal ?? false,
			line: m.line,
			column: m.column,
			endLine: m.endLine ?? m.line,
			endColumn: m.endColumn ?? m.column,
		}));
	const parsed = parseSource(input.path, input.source);
	assert.equal(parsed.diagnostics.length, 0, `core parse: ${input.path}`);
	assert.equal(
		messages.filter((m) => m.fatal || !m.rule).length,
		0,
		`provider parse: ${input.path}`,
	);
	const functions = collectFunctions(parsed.sourceFile).functions.map((f) => ({
		name: f.name,
		range: f.range,
		...measureFunctionComplexity(f),
		cognitive: 0,
	}));
	for (const m of messages.filter((m) => m.rule === "sonarjs/cognitive-complexity")) {
		const candidates = functions
			.filter(
				(f) =>
					(f.range.start.line < m.line ||
						(f.range.start.line === m.line && f.range.start.column <= m.column)) &&
					(f.range.end.line > m.line ||
						(f.range.end.line === m.line && f.range.end.column >= m.column)),
			)
			.sort(
				(a, b) =>
					a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line) ||
					a.range.end.column - a.range.start.column - (b.range.end.column - b.range.start.column),
			);
		assert.ok(candidates[0], `unmapped provider function ${input.path}:${m.line}:${m.column}`);
		assert.equal(candidates[0].cognitive, 0, "duplicate mapping");
		const match = m.message.match(/from (\d+) to/);
		assert.ok(match, "pinned diagnostic format changed");
		candidates[0].cognitive = Number(match[1]);
	}
	return { path: input.path, sha256: hash(input.source), functions, messages };
}
const start = performance.now();
const first = inputs.map(analyze);
const firstMs = performance.now() - start;
const again = performance.now();
const second = inputs.map(analyze);
const secondMs = performance.now() - again;
assert.deepEqual(first, second, "canonical evidence repeat");
const fixtureResults = fixtures.map((f) => {
	const result = first.find((r) => r.path === `fixtures/${f.name}.ts`);
	if (f.expectedCognitive)
		assert.deepEqual(
			result.functions.map((x) => x.cognitive),
			f.expectedCognitive,
			`${f.name} cognitive`,
		);
	if (f.expectedCc)
		assert.deepEqual(
			result.functions.map((x) => x.cc),
			f.expectedCc,
			`${f.name} CC`,
		);
	if (f.bugRule)
		assert.equal(
			result.messages.filter((m) => m.rule === `sonarjs/${f.bugRule}`).length,
			f.expectedBugs,
			f.name,
		);
	return {
		name: f.name,
		functions: result.functions.map(({ name, cc, maxNesting, cognitive }) => ({
			name,
			cc,
			maxNesting,
			cognitive,
		})),
		bugs: result.messages.filter((m) => m.rule !== "sonarjs/cognitive-complexity"),
	};
});
const repo = first.slice(0, production.length);
const flat = repo.flatMap((r) => r.functions.map((f) => ({ path: r.path, ...f })));
const ranking = (metric) =>
	[...flat].sort(
		(a, b) =>
			b[metric] - a[metric] ||
			a.path.localeCompare(b.path) ||
			a.range.start.line - b.range.start.line ||
			a.range.start.column - b.range.start.column,
	);
const quantiles = (metric) => {
	const sorted = flat.map((f) => f[metric]).sort((a, b) => a - b);
	return {
		max: sorted.at(-1),
		median: sorted[Math.ceil(sorted.length * 0.5) - 1],
		p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
	};
};
const key = (f) => `${f.path}:${f.range.start.line}:${f.range.start.column}`;
const topCcKeys = new Set(ranking("cc").slice(0, 15).map(key));
const rankComparison = {
	quantileMethod: "nearest-rank",
	cognitive: quantiles("cognitive"),
	cc: quantiles("cc"),
	top15Overlap: ranking("cognitive")
		.slice(0, 15)
		.filter((f) => topCcKeys.has(key(f))).length,
	tieBreak: "path, start line, start column",
	inference: "rank differences are descriptive, not validation against maintenance outcomes",
};
const bugFindings = repo.flatMap((r) =>
	r.messages
		.filter((m) => m.rule !== "sonarjs/cognitive-complexity")
		.map((m) => ({ path: r.path, ...m })),
);
const summary = {
	status: "experimental-evidence-only",
	scope:
		"core-discovered production TS/TSX restricted to src/ and scripts/; no target configs, inline directives, type services, or project execution",
	runtime: {
		bun: Bun.version,
		coreTypeScript: ts.version,
		providerTypeScript: requireProvider("typescript/package.json").version,
	},
	versions: Object.fromEntries(
		["eslint", "eslint-plugin-sonarjs", "@typescript-eslint/parser"].map((p) => [
			p,
			requireProvider(`${p}/package.json`).version,
		]),
	),
	rules,
	sharedCorpusSha256: hash(production.map((p) => `${p.path}\0${hash(p.source)}\n`).join("")),
	corpusHash: hash(
		JSON.stringify(production.map((p) => ({ path: p.path, sha256: hash(p.source) }))),
	),
	files: repo.length,
	functions: flat.length,
	mapping:
		"threshold-zero diagnostics mapped to smallest containing core function; absent diagnostic means zero; fail on parse/unmapped/duplicate diagnostics",
	repeatEvidenceStable: true,
	timingsMs: { first: firstMs, repeat: secondMs },
	checks: { fixtureCases: fixtures.length, passed: true },
	rankComparison,
	fixtureResults,
	topCognitive: ranking("cognitive").slice(0, 15),
	topCc: ranking("cc").slice(0, 15),
	bugFindings,
};
await writeFile(join(here, "evidence.json"), JSON.stringify(first, null, 2) + "\n");
await writeFile(join(here, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
	JSON.stringify(
		{
			files: summary.files,
			functions: summary.functions,
			repeatEvidenceStable: true,
			fixtureCases: fixtures.length,
			bugs: bugFindings,
			top: summary.topCognitive.slice(0, 4),
		},
		null,
		2,
	),
);
