#!/usr/bin/env bun
/**
 * Install/package smoke test (trellis-7203, SPEC §14 release stage).
 *
 * Packs the published tarball with `bun pm pack`, unpacks it into a temp
 * dir, and confirms the deterministic-pivot package still ships every asset
 * the analyzer needs now that the readiness rubric is retired:
 *
 *   1. **Metadata** — the `trellis` bin entry and the runtime dependencies
 *      the analyzer requires (commander, js-yaml, typescript, zod).
 *   2. **Analyzer assets** — the audit core, metrics, shared syntax layer,
 *      scoring formula, comparison/policy, configuration and report
 *      contracts, safeguard inspection, CLI/SDK surfaces, and the bundled
 *      standards canonical set.
 *   3. **Execution** — the packed CLI runs a real audit of a tiny fixture
 *      workspace and emits a valid SPEC §6.4 report whose analyzer version
 *      matches this checkout.
 *
 * Runs offline: the tarball is unpacked under the repo root, so the packed
 * CLI resolves its dependencies from the repo's own `node_modules` — no
 * install, no network. The temp dir is always removed.
 *
 * CLI:
 *   bun run scripts/smoke-package.ts   # exit 0 on success, 1 on failure
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ANALYZER_VERSION, SCHEMA_VERSION } from "../src/contract/index.ts";
import { PINNED_TOOLS } from "../src/providers/manifest.ts";

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "..");

/** Runtime dependencies the deterministic analyzer cannot boot without. */
const REQUIRED_DEPENDENCIES = ["commander", "js-yaml", "typescript", "zod"] as const;

/**
 * Optional pinned provider tools (trellis-ff52, SPEC §16.4) that must stay
 * OUT of the packed native runtime — they are isolated devDependencies,
 * never native core dependencies, so the packed CLI stays offline-only and
 * provider-free until an operator explicitly prepares one (AC5 isolation).
 */
const EXCLUDED_OPTIONAL_TOOLS = PINNED_TOOLS.map((entry) => entry.packageName);

/** Files the packed tarball must ship for an audit to run end to end. */
const REQUIRED_PATHS = [
	"package.json",
	"src/index.ts",
	"src/cli/main.ts",
	"src/client/index.ts",
	"src/audit/audit.ts",
	"src/audit/run.ts",
	"src/config/load.ts",
	"src/contract/index.ts",
	"src/syntax/index.ts",
	"src/metrics/complexity.ts",
	"src/metrics/erosion.ts",
	"src/metrics/duplication.ts",
	"src/metrics/cycles.ts",
	"src/safeguards/inspect.ts",
	"src/scoring/formula.ts",
	"src/report/audit-json.ts",
	"src/compare/compare.ts",
	"src/compare/policy.ts",
	"src/store/store.ts",
	"src/fleet/targets.ts",
	"src/standards/manifest.yaml",
	"src/standards/canonical/biome.json.canon",
	"src/standards/canonical/tsconfig.base.json.canon",
] as const;

export interface SmokeResult {
	tarball: string;
	packedFiles: number;
	analyzerVersion: string;
	scoreIndex: number;
}

interface PackedPackageJson {
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
}

function run(command: string, args: string[], cwd: string): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

/** Asserts the packed package.json keeps the bin entry and analyzer dependencies. */
export function verifyPackedMetadata(packageDir: string): void {
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as PackedPackageJson;
	const bin = manifest.bin?.trellis;
	if (bin === undefined || !existsSync(join(packageDir, bin))) {
		throw new Error(`packed package has no usable bin.trellis entry (got ${String(bin)})`);
	}
	const missing = REQUIRED_DEPENDENCIES.filter((dep) => manifest.dependencies?.[dep] === undefined);
	if (missing.length > 0) {
		throw new Error(`packed package is missing runtime dependencies: ${missing.join(", ")}`);
	}
	const leaked = EXCLUDED_OPTIONAL_TOOLS.filter(
		(tool) => manifest.dependencies?.[tool] !== undefined,
	);
	if (leaked.length > 0) {
		throw new Error(
			`packed package leaked optional provider tools into runtime dependencies: ` +
				`${leaked.join(", ")} — pinned tools stay isolated from the native core (trellis-ff52)`,
		);
	}
}

/** Asserts the tarball ships every analyzer asset the audit path touches. */
export function verifyPackedAssets(packageDir: string): void {
	const missing = REQUIRED_PATHS.filter((path) => !existsSync(join(packageDir, path)));
	if (missing.length > 0) {
		throw new Error(`packed tarball is missing analyzer assets:\n  ${missing.join("\n  ")}`);
	}
}

/** Writes a minimal TS workspace the packed CLI audits (one branchy function). */
function writeFixture(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		'{\n\t"name": "smoke-fixture",\n\t"version": "0.0.0"\n}\n',
	);
	writeFileSync(
		join(dir, "src", "add.ts"),
		"export function add(a: number, b: number): number {\n\tif (a > 0) {\n\t\treturn a + b;\n\t}\n\treturn b;\n}\n",
	);
}

/**
 * Packs, unpacks, verifies, and executes the packed CLI. The work directory
 * lives under the repo root so Bun's node-style module walk-up finds the
 * repo's `node_modules`, keeping the smoke offline.
 */
export function smokePackage(repoRoot: string = DEFAULT_REPO_ROOT): SmokeResult {
	const workDir = mkdtempSync(join(repoRoot, ".smoke-package-"));
	try {
		const packDir = join(workDir, "pack");
		const packageDir = join(workDir, "pkg");
		mkdirSync(packDir);
		mkdirSync(packageDir);
		run("bun", ["pm", "pack", "--destination", packDir], repoRoot);
		const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
		if (tarball === undefined) {
			throw new Error(`bun pm pack produced no tarball in ${packDir}`);
		}
		run(
			"tar",
			["-xzf", join(packDir, tarball), "-C", packageDir, "--strip-components=1"],
			repoRoot,
		);

		verifyPackedMetadata(packageDir);
		verifyPackedAssets(packageDir);

		const fixtureDir = join(workDir, "fixture");
		writeFixture(fixtureDir);
		const stdout = run(
			"bun",
			["run", join(packageDir, "src/cli/main.ts"), "audit", fixtureDir, "--json"],
			packageDir,
		);
		const report = JSON.parse(stdout) as {
			schemaVersion?: string;
			analyzerVersion?: string;
			score?: { index?: number };
		};
		if (report.schemaVersion !== SCHEMA_VERSION) {
			throw new Error(
				`packed CLI reported schemaVersion ${String(report.schemaVersion)}, want ${SCHEMA_VERSION}`,
			);
		}
		if (report.analyzerVersion !== ANALYZER_VERSION) {
			throw new Error(
				`packed CLI reported analyzerVersion ${String(report.analyzerVersion)}, want ${ANALYZER_VERSION}`,
			);
		}
		const index = report.score?.index;
		if (typeof index !== "number" || index < 0 || index > 100) {
			throw new Error(`packed CLI reported an out-of-range sloppiness index: ${String(index)}`);
		}
		return {
			tarball,
			packedFiles: REQUIRED_PATHS.length,
			analyzerVersion: ANALYZER_VERSION,
			scoreIndex: index,
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const result = smokePackage();
		console.log(
			`smoke-package: ${result.tarball} ships the analyzer (analyzer ${result.analyzerVersion});` +
				` packed CLI audited the fixture at index ${result.scoreIndex}`,
		);
	} catch (error) {
		console.error(`smoke-package: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
