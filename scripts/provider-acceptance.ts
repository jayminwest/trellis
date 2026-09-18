#!/usr/bin/env bun
/** trellis-b18d: run after tool preparation, under OS network denial; never installs. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLONE_FN, providerEntry, putFile, seedClonePair } from "../src/audit/provider-fixtures.ts";
import { auditReportSchema } from "../src/contract/index.ts";
import { discoverSourceInventory } from "../src/discovery/index.ts";
import { resolvePinnedTool } from "../src/providers/resolve.ts";

const CLI = resolve(import.meta.dir, "../src/cli/main.ts");
const root = await mkdtemp(join(tmpdir(), "trellis-provider-acceptance-"));
const scratch = join(root, "scratch");
await mkdir(scratch);

async function sourceDigest(target: string) {
	const inventory = await discoverSourceInventory(target);
	const hash = createHash("sha256");
	for (const file of inventory.files) {
		hash.update(file.path);
		hash.update(await readFile(join(target, file.path)));
	}
	return hash.digest("hex");
}

async function measure(target: string, config: string, label: string) {
	const before = await sourceDigest(target);
	const start = performance.now();
	const child = Bun.spawn([process.execPath, CLI, "audit", target, "--config", config, "--json"], {
		env: {
			PATH: "",
			TMPDIR: scratch,
			TRELLIS_LOG_LEVEL: "silent",
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr}`);
	const report = auditReportSchema.parse(JSON.parse(stdout));
	if (before !== (await sourceDigest(target))) throw new Error(`${label} changed source files`);
	if ((await readdir(scratch)).length !== 0) throw new Error(`${label} leaked scratch`);
	return {
		label,
		durationMs: Math.round(performance.now() - start),
		maxRSS: child.resourceUsage()?.maxRSS,
		sourceSha256: before,
		score: report.score,
		providers:
			report.schemaVersion === "1.1.0"
				? report.evidence.analyses
						.filter((a) => a.provider.kind === "external")
						.map((a) => ({
							id: a.provider.id,
							state: a.state,
							reason: a.reason,
							parser: a.analysis?.parser,
						}))
				: [],
		report,
	};
}

try {
	for (const id of ["jscpd", "dependency-cruiser", "knip"]) {
		const tool = resolvePinnedTool(id);
		if (tool.state !== "available") throw new Error(`${id}: ${tool.reason}`);
	}
	const nativeConfig = join(root, "native.yaml");
	const providerConfig = join(root, "providers.yaml");
	await writeFile(nativeConfig, "{}\n");
	await writeFile(
		providerConfig,
		"providers:\n  jscpd: {mode: exact}\n  dependency-cruiser:\n    rules: [{kind: cycle, name: runtime-cycles, edges: [runtime]}]\n  sonarjs: {}\n  knip: { tests: roots }\n",
	);
	const fixture = join(root, "fixture");
	await seedClonePair(fixture);
	for (const name of [".dependency-cruiser.cjs", "knip.config.ts", "trellis.config.ts"]) {
		await writeFile(join(fixture, name), 'throw new Error("target configuration executed");\n');
	}
	await writeFile(
		join(fixture, "package.json"),
		JSON.stringify({ scripts: { test: "exit 91", prepare: "exit 92" } }),
	);
	const stress = join(root, "stress");
	for (let index = 0; index < 40; index++) {
		await putFile(stress, `src/copy-${index}.ts`, CLONE_FN);
	}
	const results = [];
	for (const [label, target] of [
		["control", fixture],
		["stress-40-copies", stress],
		["trellis", resolve(import.meta.dir, "..")],
		...process.argv.slice(2).map((target) => ["representative", resolve(target)]),
	] as [string, string][]) {
		const native = await measure(target, nativeConfig, `${label}/native`);
		const enriched = await measure(target, providerConfig, `${label}/providers`);
		if (JSON.stringify(native.score) !== JSON.stringify(enriched.score))
			throw new Error("provider changed score");
		if (label === "control") {
			if (providerEntry(enriched.report, "dependency-cruiser").state !== "complete")
				throw new Error("control architecture incomplete");
			if (providerEntry(enriched.report, "sonarjs").state !== "unsupported")
				throw new Error("Sonar deferral lost");
		}
		for (const { report: _report, ...result } of [native, enriched]) results.push(result);
	}
	console.log(
		JSON.stringify(
			{ host: process.platform, arch: process.arch, bun: Bun.version, results },
			null,
			2,
		),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
