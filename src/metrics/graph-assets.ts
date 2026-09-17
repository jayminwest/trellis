import { dirname, extname, resolve } from "node:path";
import type ts from "typescript";
import { wildcardMatch } from "./graph-workspace.ts";

/** Select exactly the alias TypeScript would use: exact key, then longest prefix. */
function mappedPaths(specifier: string, paths: ts.MapLike<string[]>): string[] {
	const exact = paths[specifier];
	if (exact !== undefined) return exact;
	let bestPrefix = -1;
	let candidates: string[] = [];
	for (const [pattern, targets] of Object.entries(paths)) {
		const middle = wildcardMatch(pattern, specifier);
		const prefix = pattern.indexOf("*");
		if (middle === null || prefix <= bestPrefix) continue;
		bestPrefix = prefix;
		candidates = targets.map((target) => target.replace("*", middle));
	}
	return candidates;
}

/** Exact non-source files only; never invent extensions or bypass the guarded host. */
export function resolveAsset(
	specifier: string,
	from: string,
	options: ts.CompilerOptions,
	host: ts.ModuleResolutionHost,
): string | null {
	const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
	const base = isRelative ? dirname(from) : options.baseUrl;
	if (base === undefined) return null;
	const candidates = isRelative ? [specifier] : mappedPaths(specifier, options.paths ?? {});
	for (const candidate of candidates) {
		const path = resolve(base, candidate);
		const extension = extname(path);
		if (!extension || /^\.(?:[cm]?[jt]sx?|json)$/i.test(extension)) continue;
		if (host.fileExists(path)) return path;
	}
	return null;
}
