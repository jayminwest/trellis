import { readFile, writeFile, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tools = process.env.TRELLIS_ARCH_TOOLS || "/tmp/trellis-architecture-tools";
const temp = await realpath(await mkdtemp(join(tmpdir(), "trellis-architecture-spike-")));
const fixture = join(temp, "fixture");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const versions = {
	dependencyCruiser: (await readJson(join(tools, "node_modules/dependency-cruiser/package.json")))
		.version,
	typescript: (await readJson(join(tools, "node_modules/typescript/package.json"))).version,
	knip: (await readJson(join(root, "node_modules/knip/package.json"))).version,
};
if (
	versions.dependencyCruiser !== "17.3.8" ||
	versions.knip !== "6.16.1" ||
	versions.typescript !== "5.9.3"
)
	throw Error("Provider versions differ from pinned experiment");
const files = {
	"package.json": JSON.stringify({
		name: "architecture-controls",
		type: "module",
		exports: "./src/main.ts",
	}),
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			module: "ESNext",
			moduleResolution: "Bundler",
			allowImportingTsExtensions: true,
		},
		include: ["src/**/*.ts"],
	}),
	"src/main.ts":
		'import { used } from "./live.ts";\nimport { first } from "./cycle-a.ts";\nimport "./domain/bad.ts";\nimport "./domain/good.ts";\nimport "./missing.ts";\nimport type { A } from "./type-a.ts";\nexport const publicApi = (x: A) => [used, first, x];\nexport const lazy = () => import("./lazy.ts");\n',
	"src/live.ts": "export const used = 1;\nexport const unused = 2;\n",
	"src/dead.ts": "export const orphan = 0;\n",
	"src/lazy.ts": "export const lazyValue = 3;\n",
	"src/cycle-a.ts":
		'import { second } from "./cycle-b.ts";\nexport const first = () => second();\n',
	"src/cycle-b.ts": 'import { first } from "./cycle-a.ts";\nexport const second = () => first;\n',
	"src/domain/bad.ts": 'import { view } from "../ui/view.ts";\nexport const bad = view;\n',
	"src/domain/good.ts": 'import { util } from "../shared/util.ts";\nexport const good = util;\n',
	"src/ui/view.ts": "export const view = 1;\n",
	"src/shared/util.ts": "export const util = 2;\n",
	"src/type-a.ts": 'import type { B } from "./type-b.ts";\nexport interface A { b?: B }\n',
	"src/type-b.ts": 'import type { A } from "./type-a.ts";\nexport interface B { a?: A }\n',
};
await mkdir(fixture, { recursive: true });
for (const [path, source] of Object.entries(files)) {
	await mkdir(dirname(join(fixture, path)), { recursive: true });
	await writeFile(join(fixture, path), source);
}
await writeJson(join(here, "fixture-files.json"), files);
const { Plugins } = await import(join(root, "node_modules/knip/dist/plugins/index.js"));
const disabledPlugins = Object.fromEntries(Object.keys(Plugins).map((name) => [name, false]));
const corpus = await readJson(join(here, "../provider-spike-corpus.json"));
for (const file of corpus.files) {
	if (
		createHash("sha256")
			.update(await readFile(join(root, file.path)))
			.digest("hex") !== file.sha256
	)
		throw Error("Corpus changed: " + file.path);
}
const summary = {
	corpusSha256: corpus.sha256,
	corpusFiles: corpus.files.length,
	versions,
	runtime: process.version,
	commands: [],
	experiments: {},
};
function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		timeout: 120000,
	});
	if (result.error) throw result.error;
	if (![0, 1].includes(result.status))
		throw Error(`${command}: ${result.status}: ${result.stderr}`);
	summary.commands.push({
		command,
		args: args.map((x) =>
			x.replaceAll(temp, "<temp>").replaceAll(root, "<repo>").replaceAll(tools, "<tools>"),
		),
		cwd: cwd.replaceAll(temp, "<temp>").replaceAll(root, "<repo>"),
		exit: result.status,
		stderr: result.stderr.replaceAll(temp, "<temp>").replaceAll(root, "<repo>"),
	});
	return JSON.parse(result.stdout);
}
const normalize = (value) =>
	JSON.parse(
		JSON.stringify(value)
			.replaceAll(temp, "<temp>")
			.replaceAll(root, "<repo>")
			.replaceAll(tools, "<tools>"),
	);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
for (const [name, cwd] of [
	["fixture", fixture],
	["trellis", root],
]) {
	const cruiseConfig = {
		forbidden: [
			{ name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
			{ name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
			{
				name: "domain-must-not-import-ui",
				severity: "error",
				from: {
					path: name === "fixture" ? "^src/domain/" : "^src/(audit|metrics|scoring|compare)/",
				},
				to: { path: name === "fixture" ? "^src/ui/" : "^src/cli/" },
			},
		],
		options: {
			doNotFollow: { path: "node_modules" },
			exclude: { path: "\\.test\\.ts$" },
			tsPreCompilationDeps: true,
			tsConfig: { fileName: join(cwd, "tsconfig.json") },
			enhancedResolveOptions: {
				extensions: [".ts", ".tsx", ".js", ".json"],
				conditionNames: ["import", "require", "node", "default"],
			},
		},
	};
	const cc = join(temp, `${name}-cruise.json`);
	await writeJson(cc, cruiseConfig);
	const knipConfig = {
		...disabledPlugins,
		entry:
			name === "fixture"
				? ["src/main.ts"]
				: [
						"src/index.ts",
						"src/client/index.ts",
						"src/cli/main.ts",
						...corpus.files.map((f) => f.path).filter((p) => p.startsWith("scripts/")),
					],
		project: name === "fixture" ? ["src/**/*.ts"] : corpus.files.map((f) => f.path),
		ignore: ["**/*.test.ts", "**/__golden__/**"],
		ignoreUnresolved: ["bun-types"],
	};
	const kc = join(temp, `${name}-knip.json`);
	await writeJson(kc, knipConfig);
	const configs = normalize({ dependencyCruiser: cruiseConfig, knip: knipConfig });
	await writeJson(join(here, `${name}-config.json`), configs);
	const cruiseargs = [
		join(tools, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"),
		"--config",
		cc,
		"--output-type",
		"json",
		...(name === "fixture" ? ["src"] : corpus.files.map((f) => f.path)),
	];
	const knipargs = [
		join(root, "node_modules/knip/bin/knip.js"),
		"--directory",
		cwd,
		"--config",
		kc,
		"--tsConfig",
		join(cwd, "tsconfig.json"),
		"--reporter",
		"json",
		"--include",
		"files,exports,types,unresolved",
		"--no-config-hints",
		"--no-tag-hints",
	];
	const results = {};
	const raw = {};
	for (const [provider, args] of [
		["dependencyCruiser", cruiseargs],
		["knip", knipargs],
	]) {
		const firstRaw = normalize(run("node", args, cwd));
		const secondRaw = normalize(run("node", args, cwd));
		const order = (value) =>
			provider === "knip"
				? {
						...value,
						issues: [...value.issues].sort((a, b) =>
							a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
						),
					}
				: value;
		const first = order(firstRaw);
		const second = order(secondRaw);
		await writeJson(join(here, `${name}-${provider}-raw.json`), firstRaw);
		assert.deepEqual(first, second, `${name}/${provider} repeated output differs`);
		raw[provider] = first;
		if (provider === "dependencyCruiser")
			assert(first.modules.length > 0, "Empty graph is not successful analysis");
		await writeJson(join(here, `${name}-${provider}.json`), first);
		results[provider] = {
			rawRepeatIdentical: JSON.stringify(firstRaw) === JSON.stringify(secondRaw),
			repeatIdentical: JSON.stringify(first) === JSON.stringify(second),
			sha256: hash(first),
			...(provider === "dependencyCruiser"
				? { modules: first.modules.length, violations: first.summary.violations }
				: {
						counts: Object.fromEntries(
							["files", "exports", "types", "unresolved"].map((k) => [
								k,
								first.issues.reduce((n, i) => n + i[k].length, 0),
							]),
						),
					}),
		};
	}
	if (name === "fixture") {
		const violations = raw.dependencyCruiser.summary.violations;
		assert.equal(violations.length, 4);
		assert.deepEqual(
			violations.filter((v) => v.type === "cycle").map((v) => [v.from, v.to]),
			[
				["src/cycle-a.ts", "src/cycle-b.ts"],
				["src/type-a.ts", "src/type-b.ts"],
			],
		);
		assert(
			violations.some(
				(v) => v.rule.name === "domain-must-not-import-ui" && v.from === "src/domain/bad.ts",
			),
		);
		assert(!violations.some((v) => v.from === "src/domain/good.ts"));
		assert(violations.some((v) => v.rule.name === "no-unresolved" && v.to === "./missing.ts"));
		const issues = raw.knip.issues;
		assert.deepEqual(
			issues.flatMap((i) => i.files.map((f) => f.name)),
			["src/dead.ts"],
		);
		assert.deepEqual(
			issues.flatMap((i) => i.exports.map((e) => `${i.file}:${e.name}`)),
			["src/domain/bad.ts:bad", "src/domain/good.ts:good", "src/live.ts:unused"],
		);
		assert.deepEqual(
			issues.flatMap((i) => i.unresolved.map((u) => u.name)),
			["./missing.ts"],
		);
		assert(!issues.some((i) => i.file === "src/main.ts" && i.exports.length));
		results.controls =
			"Four expected graph findings and five expected Knip findings; no extras in selected categories. Live import, literal dynamic import, and public entry exports retained.";
	} else {
		const sources = new Set(raw.dependencyCruiser.modules.map((m) => m.source));
		assert(
			corpus.files.every((f) => sources.has(f.path)),
			"Provider omitted a production file",
		);
	}
	summary.experiments[name] = results;
}
await writeJson(join(here, "summary.json"), summary);
console.log(JSON.stringify({ versions, experiments: summary.experiments }, null, 2));
