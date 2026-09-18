/** Standalone research. Run: bun run docs/research/fallow-spike/run.mjs /absolute/path/to/fallow */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditWorkspace } from "../../../src/audit/index.ts";
import { compareFindings } from "../../../src/compare/diff.ts";
import { discoverSourceInventory } from "../../../src/discovery/index.ts";
import { buildSyntaxInventory } from "../../../src/syntax/index.ts";
import { analyzeDuplication } from "../../../src/metrics/analyze-duplication.ts";

const binary = resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), "trellis-fallow-controls-"));
const env = { ...process.env, DO_NOT_TRACK: "1", FALLOW_TELEMETRY: "0" };
for (const key of Object.keys(env)) {
	if (key.startsWith("FALLOW_") && key !== "FALLOW_TELEMETRY") delete env[key];
}
function command(executable, args, cwd) {
	const result = spawnSync(executable, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.signal || !(executable === "git" ? [0] : [0, 1]).includes(result.status)) {
		throw new Error(
			JSON.stringify({
				executable,
				args,
				status: result.status,
				error: result.error?.message,
				stderr: result.stderr,
			}),
		);
	}
	return result;
}
function fallow(args, root) {
	const start = performance.now();
	const result = command(
		binary,
		[...args, "--root", root, "--format", "json", "--quiet", "--no-cache"],
		root,
	);
	return { exit: result.status, ms: performance.now() - start, report: JSON.parse(result.stdout) };
}
async function fixture(name, files) {
	const root = join(scratch, name);
	await mkdir(root);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name, type: "module", main: "index.ts" }),
	);
	await writeFile(
		join(root, ".fallowrc.json"),
		JSON.stringify({
			entry: ["index.ts"],
			duplicates: { ignoreImports: false },
			health: { maxCyclomatic: 10, maxCognitive: 1000, maxCrap: 100000 },
		}),
	);
	for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
	return root;
}
const hot = (name, count = 12) =>
	`export function ${name}(x: number) {\n${Array.from({ length: count }, (_, i) => ` if (x === ${i}) return ${i + 1};`).join("\n")}\n return x;\n}\n`;
const counts = (diff) => ({
	new: diff.new.length,
	resolved: diff.resolved.length,
	persistent: diff.persistent.length,
});
const hotspot = (report) => report.findings.filter((f) => f.kind === "complexity.hotspot");
const results = {
	protocol: "fallow-spike-v1",
	trellisCommit: command("git", ["rev-parse", "HEAD"], process.cwd()).stdout.trim(),
	fallowVersion: command(binary, ["--version"], scratch).stdout.trim(),
	fixtures: [],
	attribution: [],
	duplication: [],
};
try {
	const cases = [
		["two-unchanged", hot("alpha") + hot("beta"), "// shifted\n" + hot("alpha") + hot("beta")],
		["add-third", hot("alpha") + hot("beta"), hot("alpha") + hot("beta") + hot("gamma")],
		["replace-only", hot("alpha"), hot("beta", 14)],
		[
			"duplicate-method-name",
			`export class A { ${hot("run").replace("export function ", "")} }\n`,
			`export class A { ${hot("run").replace("export function ", "")} }\nexport class B { ${hot("run").replace("export function ", "")} }\n`,
		],
	];
	for (const [name, before, after] of cases) {
		results.fixtures.push({ name, before, after });
		const root = await fixture(name, { "index.ts": before });
		command("git", ["init", "-q"], root);
		command("git", ["add", "."], root);
		command(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"fixture: baseline",
			],
			root,
		);
		const baseline = await auditWorkspace(root);
		await writeFile(join(root, "index.ts"), after);
		command("git", ["add", "index.ts"], root);
		command(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-qm",
				"fixture: change",
			],
			root,
		);
		const current = await auditWorkspace(root);
		const audit = fallow(["audit", "--base", "HEAD~1", "--no-css"], root);
		const findings = audit.report.complexity?.findings ?? [];
		results.attribution.push({
			name,
			trellis: counts(compareFindings(hotspot(baseline), hotspot(current))),
			trellisNames: hotspot(current).map((f) => f.facts.name),
			fallow: { exit: audit.exit, attribution: audit.report.attribution, findings },
		});
	}
	const original = hot("alpha", 24);
	const renamed = original.replaceAll("alpha", "beta").replaceAll(/\bx\b/g, "value");
	const edited = renamed.replace(
		" if (value === 12) return 13;",
		" console.log(value);\n if (value === 12) return 13;",
	);
	const doc = (name, text) =>
		`/**\n${Array.from({ length: 35 }, () => ` * ${text}`).join("\n")}\n */\nexport const ${name} = 1;\n`;
	const prior = JSON.parse(
		await readFile(new URL("../jscpd-provider-spike/fixtures.json", import.meta.url), "utf8"),
	);
	const priorNear = prior.find((item) => item.name === "near");
	const expand = (code) =>
		code.replace(
			" let accepted = 0;",
			" let accepted = 0;\n const adjusted = items.map(value => Math.abs(value)).filter(value => Number.isFinite(value));\n if (!adjusted.length) return limit;\n subtotal += adjusted.length;",
		);
	const duplicateCases = [
		["exact", { "a.ts": original, "b.ts": original }],
		["renamed", { "a.ts": original, "b.ts": renamed }],
		["edited-copy", { "a.ts": original, "b.ts": edited }],
		[
			"jsdoc-only",
			{
				"a.ts": doc("a", "A sufficiently long shared documentation sentence."),
				"b.ts": doc("b", "A sufficiently long shared documentation sentence."),
			},
		],
		[
			"near-diverse",
			Object.fromEntries(
				Object.entries(priorNear.files).map(([path, code]) => [path, expand(code)]),
			),
		],
		["unrelated", prior.find((item) => item.name === "unrelated").files],
		[
			"imports-only",
			Object.fromEntries(
				["a.ts", "b.ts"].map((path) => [
					path,
					Array.from({ length: 30 }, (_, i) => `import { value${i} } from "library${i}";`).join(
						"\n",
					) + "\n",
				]),
			),
		],
		...[2, 10, 40].map((count) => [
			`repeated-${count}`,
			Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.ts`, hot(`fn${i}`, 24)])),
		]),
	];
	for (const [name, files] of duplicateCases) {
		results.fixtures.push({ name, files });
		const root = await fixture(name, files);
		const syntax = await buildSyntaxInventory(await discoverSourceInventory(root));
		assert.equal(
			syntax.files.some((file) => file.sourceFile.parseDiagnostics.length > 0),
			false,
			`${name}: invalid fixture`,
		);
		const start = performance.now();
		const native = analyzeDuplication(syntax).scopes.production;
		const trellis = {
			ms: performance.now() - start,
			tokens: native.tokenCount,
			groups: native.groups.length,
			exhaustion: native.exhaustion,
			duplicatedLines: native.duplicatedLines,
			codeLines: native.codeLines,
		};
		const observations = [];
		for (const mode of [
			"semantic",
			...(["edited-copy", "near-diverse", "unrelated"].includes(name) ? ["semantic-near"] : []),
			...(name === "imports-only" ? ["semantic-ignore-imports"] : []),
		]) {
			if (mode.endsWith("ignore-imports"))
				await writeFile(
					join(root, ".fallowrc.json"),
					JSON.stringify({ duplicates: { ignoreImports: true } }),
				);
			const run = fallow(
				[
					"dupes",
					"--mode",
					"semantic",
					"--min-tokens",
					"100",
					"--min-lines",
					"3",
					...(mode.endsWith("near") ? ["--near"] : []),
				],
				root,
			);
			observations.push({
				mode,
				ms: run.ms,
				exit: run.exit,
				stats: run.report.stats,
				groups: run.report.clone_groups?.map((g) => ({
					tokens: g.token_count,
					lines: g.line_count,
					similarity: g.similarity,
					instances: g.instances.map((i) => ({
						file: i.file.replace(root, "<fixture>"),
						start: i.start_line,
						end: i.end_line,
					})),
				})),
			});
		}
		results.duplication.push({ name, trellis, fallow: observations });
	}
	assert.deepEqual(results.attribution[0].trellis, { new: 2, resolved: 2, persistent: 0 });
	assert.deepEqual(results.attribution[2].trellis, { new: 0, resolved: 0, persistent: 1 });
	assert.deepEqual(
		results.attribution.map((row) => row.fallow.attribution.complexity_introduced),
		[0, 1, 1, 0],
	);
	assert.deepEqual(
		results.attribution.map((row) => row.fallow.findings.length),
		[2, 3, 1, 2],
	);
	assert.equal(
		results.duplication.find((row) => row.name === "repeated-40").trellis.exhaustion.kind,
		"match-work",
	);
	assert.equal(
		results.duplication.find((row) => row.name === "repeated-40").fallow[0].groups[0].instances
			.length,
		40,
	);
	assert.ok(
		results.duplication
			.find((row) => row.name === "near-diverse")
			.fallow[1].groups.some((group) => group.similarity > 0.8),
	);
	assert.equal(
		results.duplication.find((row) => row.name === "unrelated").fallow[1].groups.length,
		0,
	);
	results.fixtureSha256 = createHash("sha256")
		.update(JSON.stringify(results.fixtures))
		.digest("hex");
	delete results.fixtures;
	console.log(JSON.stringify(results, null, 2));
} finally {
	// Fallow's base cache is outside the fixture; request its own cleanup before removing roots.
	for (const item of results.attribution)
		command(
			binary,
			["audit-cache", "remove", "--root", join(scratch, item.name), "--yes"],
			scratch,
		);
	await rm(scratch, { recursive: true, force: true });
}
