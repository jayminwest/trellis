/**
 * Source-set classification (SPEC §3.1) — documented defaults plus explicit
 * per-repo overrides from the audit configuration (§6.5).
 *
 * Recognized TypeScript source: `.ts`, `.tsx`, `.mts`, `.cts`. Declaration
 * files (`.d.ts`, `.d.mts`, `.d.cts`) classify `declaration-only` by default.
 * Everything else is unsupported surface (§3.3) — see
 * {@link UNSUPPORTED_SOURCE_EXTENSIONS}.
 *
 * Classification precedence (first match wins):
 * 0. config `source.exclude` — handled by the inventory walk; an excluded
 *    file is never classified at all.
 * 1. config `source.classify` — explicit overrides win over every default;
 *    patterns are evaluated in sorted order so ties are deterministic.
 * 2. `vendored` — any ancestor directory named `vendor` or `third_party`.
 * 3. `generated` — any ancestor directory named `generated` / `__generated__`,
 *    or a basename marker `.gen.` / `.generated.`.
 * 4. `declaration-only` — `*.d.ts` / `*.d.mts` / `*.d.cts`.
 * 5. `test` — basename marker `.test.` / `.spec.`, or any ancestor directory
 *    named `test` / `tests` / `__tests__`.
 * 6. `production` — everything else.
 */
import type { SourceConfig, SourceSet } from "../contract/index.ts";
import { matchGlob } from "./glob.ts";

const TS_SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION_RE = /\.d\.(?:ts|mts|cts)$/;
const TEST_BASENAME_RE = /\.(?:test|spec)\.[^.]+$/;
const GENERATED_BASENAME_RE = /\.(?:gen|generated)\.[^.]+$/;

const VENDORED_DIRS = new Set(["vendor", "third_party"]);
const GENERATED_DIRS = new Set(["generated", "__generated__"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

/**
 * File extensions counted as **unsupported** source surface (SPEC §3.3): real
 * source in languages trellis does not analyze (including JavaScript — the
 * audit is TS/TSX only per §2 non-goals). Reported as coverage, never as
 * cleanliness.
 */
export const UNSUPPORTED_SOURCE_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".jsx",
	".py",
	".swift",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".rb",
	".php",
	".c",
	".h",
	".cc",
	".cpp",
	".hpp",
	".cs",
	".scala",
] as const;

/** True when `path` is a TypeScript source file (`.ts`/`.tsx`/`.mts`/`.cts`). */
export function isTypeScriptSource(path: string): boolean {
	return TS_SOURCE_RE.test(path);
}

/** True when `path` is an unsupported (non-TS) source file per {@link UNSUPPORTED_SOURCE_EXTENSIONS}. */
export function isUnsupportedSource(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	const ext = path.slice(dot).toLowerCase();
	return (UNSUPPORTED_SOURCE_EXTENSIONS as readonly string[]).includes(ext);
}

/** The outcome of classifying one TS/TSX file. */
export interface Classification {
	/** The assigned source set (SPEC §3.1). */
	sourceSet: SourceSet;
	/** Traceable rule id, e.g. `config:classify:<pattern>` or `default:test`. */
	rule: string;
}

/**
 * Classify one repo-relative TS/TSX path into exactly one source set using the
 * precedence documented above. Pure: no filesystem access. Exclusion is NOT
 * checked here — excluded files never reach classification.
 */
export function classifyTsFile(path: string, config?: SourceConfig): Classification {
	const overrides = config?.classify ?? {};
	for (const pattern of Object.keys(overrides).sort()) {
		if (matchGlob(pattern, path)) {
			const set = overrides[pattern] as SourceSet;
			return { sourceSet: set, rule: `config:classify:${pattern}` };
		}
	}
	const segments = path.split("/");
	const basename = segments[segments.length - 1] ?? path;
	const dirs = segments.slice(0, -1);
	if (dirs.some((segment) => VENDORED_DIRS.has(segment))) {
		return { sourceSet: "vendored", rule: "default:vendored-dir" };
	}
	if (dirs.some((segment) => GENERATED_DIRS.has(segment)) || GENERATED_BASENAME_RE.test(basename)) {
		return { sourceSet: "generated", rule: "default:generated" };
	}
	if (DECLARATION_RE.test(basename)) {
		return { sourceSet: "declaration-only", rule: "default:declaration" };
	}
	if (TEST_BASENAME_RE.test(basename) || dirs.some((segment) => TEST_DIRS.has(segment))) {
		return { sourceSet: "test", rule: "default:test" };
	}
	return { sourceSet: "production", rule: "default:production" };
}
