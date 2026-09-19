import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { discoverSourceInventory } from "../../../src/discovery/inventory.ts";
import { buildSyntaxInventory } from "../../../src/syntax/inventory.ts";
import { analyzeDuplication } from "../../../src/metrics/analyze-duplication.ts";
import { classifyLines } from "../../../src/syntax/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const temp = "/tmp/trellis-jscpd-spike";
const binary = process.env.JSCPD_BINARY || join(temp, "jscpd");
const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout?.trim();
if (version !== "jscpd 5.2.1") throw new Error(`Expected jscpd 5.2.1, got ${version}`);
const save = (name, value) => writeFile(join(here, name), `${JSON.stringify(value, null, 2)}\n`);
const fixtures = JSON.parse(await readFile(join(here, "fixtures.json"), "utf8"));
await mkdir(temp, { recursive: true });
await writeFile(join(temp, "config.json"), "{}");
await writeFile(
	join(here, "jscpd-help.txt"),
	spawnSync(binary, ["--help"], { encoding: "utf8" }).stdout,
);
const result = {
	version,
	binarySha256: createHash("sha256")
		.update(await readFile(binary))
		.digest("hex"),
	platform: process.platform,
	arch: process.arch,
	date: new Date().toISOString(),
	baseCommit: spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).stdout.trim(),
	note: "Three sequential warm-cache runs, not a representative benchmark; core timings include discovery and parsing, subprocess timings include startup and JSON reporting.",
	datasets: [],
};
const modes = {
	exact: [],
	normalized: ["--ignore-identifiers", "--ignore-literals"],
	near: [
		"--ignore-identifiers",
		"--ignore-literals",
		"--max-gap-lines",
		"2",
		"--similarity",
		"0.85",
	],
};
function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([key]) =>
						!["detectionDate", "foundDate", "timestamp", "date", "executionTime"].includes(key),
				)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, stable(item)]),
		);
	return typeof value === "string" ? value.replaceAll(temp, "<temp>") : value;
}
function normalize(report) {
	const clones = report.duplicates
		.map((clone) => stable(clone))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return { statistics: stable(report.statistics), duplicates: clones };
}
function affectedLines(clones, syntax) {
	const lines = new Map();
	for (const clone of clones)
		for (const fragment of [clone.firstFile, clone.secondFile]) {
			const name = fragment.name.replaceAll("\\", "/");
			const file = syntax.files.find(
				(item) => name === item.path || name.endsWith(`/${item.path}`),
			);
			if (!file) throw new Error(`Unknown clone file ${name}`);
			const covered = lines.get(file.path) || new Set();
			for (let line = fragment.start; line <= fragment.end; line++) covered.add(line);
			lines.set(file.path, covered);
		}
	let physical = 0,
		code = 0;
	for (const file of syntax.files) {
		const covered = lines.get(file.path) || new Set();
		physical += covered.size;
		const kinds = classifyLines(file.sourceFile);
		for (const line of covered) if (kinds[line - 1] === "code") code++;
	}
	return { unionPhysicalLines: physical, unionTrellisCodeLines: code };
}
async function run(name, dir, expectation) {
	const coreRuns = [];
	let syntax, own;
	for (let repeat = 0; repeat < 3; repeat++) {
		const start = performance.now();
		syntax = await buildSyntaxInventory(await discoverSourceInventory(dir));
		own = analyzeDuplication(syntax).scopes.production;
		coreRuns.push({
			elapsedMs: +(performance.now() - start).toFixed(3),
			canonical: JSON.stringify(stable(own)),
		});
	}
	const dataset = {
		name,
		expectation,
		files: syntax.files.length,
		parseCompleteness: syntax.completeness,
		trellis: {
			groups: own.groups.length,
			unionCodeLines: own.duplicatedLines,
			codeLines: own.codeLines,
			density: own.density,
			exhaustion: own.exhaustion,
			elapsedMs: coreRuns.map((x) => x.elapsedMs),
			repeatedEvidenceEqual: new Set(coreRuns.map((x) => x.canonical)).size === 1,
		},
		providers: {},
	};
	await save(`${name}-trellis.json`, own);
	for (const [mode, flags] of Object.entries(modes)) {
		const runs = [];
		for (let repeat = 0; repeat < 3; repeat++) {
			const output = join(temp, "output");
			await rm(output, { recursive: true, force: true });
			const args = [
				dir,
				"--config",
				join(temp, "config.json"),
				"--min-tokens",
				"50",
				"--min-lines",
				"3",
				"--mode",
				"weak",
				"--no-gitignore",
				"--workers",
				"1",
				"--max-size",
				"100mb",
				"--reporters",
				"json",
				"--output",
				output,
				"--silent",
				"--no-tips",
				...flags,
			];
			const start = performance.now();
			const proc = spawnSync(binary, args, { encoding: "utf8", cwd: temp, timeout: 60000 });
			const elapsedMs = +(performance.now() - start).toFixed(3);
			if (proc.status !== 0) throw new Error(`${name}/${mode}: ${proc.stderr}`);
			const raw = JSON.parse(await readFile(join(output, "jscpd-report.json"), "utf8"));
			const canonical = normalize(raw);
			runs.push({ elapsedMs, canonical: JSON.stringify(canonical) });
			if (repeat === 0) {
				await save(`${name}-${mode}.json`, raw);
				dataset.providers[mode] = {
					args: args.map((x) => x.replaceAll(temp, "<temp>")),
					clonePairs: raw.duplicates.length,
					...affectedLines(raw.duplicates, syntax),
					statistics: raw.statistics.total,
				};
			}
		}
		Object.assign(dataset.providers[mode], {
			elapsedMs: runs.map((x) => x.elapsedMs),
			evidenceSha256: runs.map((x) => createHash("sha256").update(x.canonical).digest("hex")),
			repeatedEvidenceEqual: new Set(runs.map((x) => x.canonical)).size === 1,
		});
	}
	result.datasets.push(dataset);
	await save("summary.json", result);
	console.log(name, JSON.stringify(dataset));
}
for (const fixture of fixtures) {
	const dir = join(temp, fixture.name);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	for (const [file, source] of Object.entries(fixture.files))
		await writeFile(join(dir, file), source);
	await run(fixture.name, dir, fixture.expectation);
}
const source = await discoverSourceInventory(root);
const production = source.files.filter((file) => file.sourceSet === "production");
const corpus = join(temp, "production");
await rm(corpus, { recursive: true, force: true });
await mkdir(corpus, { recursive: true });
for (const file of production) {
	const dest = join(corpus, file.path);
	await mkdir(dirname(dest), { recursive: true });
	await cp(join(root, file.path), dest);
}
const manifest = await Promise.all(
	production.map(async (file) => ({
		path: file.path,
		sha256: createHash("sha256")
			.update(await readFile(join(corpus, file.path)))
			.digest("hex"),
	})),
);
result.sharedCorpusSha256 = createHash("sha256")
	.update(manifest.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
	.digest("hex");
result.productionManifestSha256 = createHash("sha256")
	.update(JSON.stringify(manifest))
	.digest("hex");
await save("production-inventory.json", manifest);
await writeFile(
 join(here, "../provider-spike-corpus.json"),
 `${JSON.stringify({
  protocol: "provider-corpus-v1",
  scope: "trellis-discovery-production",
  sha256: result.sharedCorpusSha256,
  files: manifest,
 }, null, 2)}\n`,
);
await run(
	"production",
	corpus,
	"Observational corpus; no ground-truth labels. Explicit trellis production inventory copied without project config or dependencies.",
);
const expected = {
	exact: [1, 1, 1, 1],
	renamed: [1, 0, 1, 1],
	near: [0, 0, 0, 1],
	unrelated: [0, 0, 0, 0],
	idiom: [1, 0, 1, 1],
};
for (const dataset of result.datasets) {
	if (expected[dataset.name])
		assert.deepEqual(
			[
				dataset.trellis.groups,
				...Object.values(dataset.providers).map((provider) => provider.clonePairs),
			],
			expected[dataset.name],
			dataset.name,
		);
	assert.equal(dataset.trellis.repeatedEvidenceEqual, true, `${dataset.name}: core stability`);
	for (const provider of Object.values(dataset.providers))
		assert.equal(provider.repeatedEvidenceEqual, true, `${dataset.name}: provider stability`);
}
result.fixtureAssertionsPassed = true;
await save("summary.json", result);
console.log("Fixture and normalized repeatability assertions passed.");
