/**
 * Build-output → source mapping for workspace package entries (SPEC §5.4,
 * graph policy 1.1.0, trellis-a98b) — pure apart from the injected config
 * reader.
 *
 * A fresh clone of a monorepo usually has no `dist/`: manifest `exports`,
 * `main` and `types` name build output that does not exist, and trellis never
 * runs the target's build. When no manifest candidate names an existing file,
 * the resolver retries each candidate mapped back to source — first through
 * the package's own tsconfig `outDir`/`declarationDir` → `rootDir`
 * (`tsconfig.json`, then `tsconfig.build.json`), then the conventional
 * `dist|build|lib|out` → `src` — with the output extension stripped so the
 * compiler's own extension probing finds `.ts`/`.tsx` sources.
 */
import { relative } from "node:path";
import type ts from "typescript";

/** A build-output → source directory mapping, both relative to the package root. */
export interface OutputMapping {
	outDir: string;
	rootDir: string;
}

/** Package-relative POSIX path of `absPath` under `absPkg`, or null when outside it. */
function packageRelative(absPkg: string, absPath: string): string | null {
	const rel = relative(absPkg, absPath).replace(/\\/g, "/");
	return rel.startsWith("..") ? null : rel;
}

/** The `outDir`/`declarationDir` → `rootDir` mappings of one parsed package tsconfig. */
function configOutputMappings(absPkg: string, options: ts.CompilerOptions): OutputMapping[] {
	const rootDir = options.rootDir === undefined ? "src" : packageRelative(absPkg, options.rootDir);
	if (rootDir === null) return [];
	return [options.outDir, options.declarationDir].flatMap((out) => {
		const outDir = out === undefined ? null : packageRelative(absPkg, out);
		return outDir === null || outDir === "" ? [] : [{ outDir, rootDir }];
	});
}

/**
 * The package's declared mappings, deduplicated in config order.
 * `readOptions` returns a config's parsed options, or `undefined` when absent.
 */
export function collectOutputMappings(
	absPkg: string,
	readOptions: (absConfig: string) => ts.CompilerOptions | undefined,
): OutputMapping[] {
	const mappings: OutputMapping[] = [];
	for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
		const options = readOptions(`${absPkg}/${name}`);
		if (options === undefined) continue;
		for (const mapping of configOutputMappings(absPkg, options)) {
			if (!mappings.some((m) => m.outDir === mapping.outDir && m.rootDir === mapping.rootDir)) {
				mappings.push(mapping);
			}
		}
	}
	return mappings;
}

/** Conventional build-output directories mapped back to `src/` when no tsconfig says otherwise. */
const BUILD_OUTPUT_DIRS = ["dist", "build", "lib", "out"] as const;

/** Strip a build-output extension (`.d.ts`, `.js`, …) so source extensions can be probed. */
function stripOutputExtension(path: string): string {
	return path.replace(/\.d\.[mc]?ts$/, "").replace(/\.[mc]?js$/, "");
}

/**
 * Source candidates for a manifest entry that points at absent build output
 * (trellis-a98b): each `outDir` → `rootDir` mapping from the package's own
 * tsconfig first, then the conventional `dist|build|lib|out` → `src`
 * mapping, with the output extension stripped. Pure; returns `[]` when the
 * entry lies under no output directory.
 */
export function sourceCandidatesForOutput(
	candidate: string,
	mappings: readonly OutputMapping[],
): string[] {
	const cleaned = candidate.replace(/^\.\//, "");
	const all = [...mappings, ...BUILD_OUTPUT_DIRS.map((outDir) => ({ outDir, rootDir: "src" }))];
	const results: string[] = [];
	for (const { outDir, rootDir } of all) {
		const prefix = outDir === "" ? "" : `${outDir}/`;
		if (outDir === "" || !cleaned.startsWith(prefix)) continue;
		const rest = stripOutputExtension(cleaned.slice(prefix.length));
		const mapped = rootDir === "" ? rest : `${rootDir}/${rest}`;
		if (!results.includes(mapped)) results.push(mapped);
	}
	return results;
}
