/**
 * Recognizable command references (SPEC §5.5, trellis-a97d).
 *
 * Safeguard inspection never executes shell and never claims arbitrary shell
 * behavior is proven. These helpers recognize a **small documented set** of
 * command shapes inside manifest script bodies, workflow `run:` values, and
 * hook commands:
 *
 * - **script references** — `bun run <name>`, `npm run <name>`,
 *   `pnpm run <name>`, `yarn run <name>` (the supported wiring between a
 *   manifest script and the checks it chains);
 * - **check commands** — lint (`biome check|lint|ci`, `eslint`, `oxlint`),
 *   typecheck (`tsc --noEmit`), and test (`bun test`, `vitest`, `jest`,
 *   `node --test`, `mocha`);
 * - **repo-local path references** — tokens shaped like `./x/y`, `x/y/z.ts`,
 *   or `scripts/budgets.json` (a slash is mandatory, URLs and package names
 *   are excluded), used to verify hook/check targets exist on disk.
 *
 * Anything else — pipes, substitutions, env vars, inline programs — is left
 * unrecognized on purpose: unrecognized constructs stay unverified.
 */

/** The check kinds recognized in script/CI command bodies. */
export type CheckKind = "lint" | "typecheck" | "test";

/** `bun run check:all` / `npm run lint` / … → the referenced script name. */
const RUN_REFERENCE_RE = /\b(?:bun|npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_-]+)/g;

/** Every script name referenced via a documented `run` form, in order. */
export function extractRunReferences(command: string): string[] {
	const names: string[] = [];
	for (const match of command.matchAll(RUN_REFERENCE_RE)) {
		if (match[1] !== undefined) names.push(match[1]);
	}
	return names;
}

const LINT_RE = /\b(?:biome\s+(?:check|lint|ci)|eslint|oxlint)\b/;
const TYPECHECK_RE = /\btsc\b/;
const NO_EMIT_RE = /(?:^|\s)--noEmit(?:\s|$|=)/;
const TEST_RE = /\b(?:bun\s+test|vitest|jest|node\s+--test|mocha)\b/;

/**
 * Recognize a lint/typecheck/test invocation inside `command`, or `null` when
 * the command matches none of the documented shapes. `tsc` only counts with
 * an explicit `--noEmit` (an emitting build is not a typecheck gate). A bare
 * `run` reference (`bun run test`) is a script reference, not a check command.
 */
export function recognizeCheck(command: string): CheckKind | null {
	if (TEST_RE.test(command)) return "test";
	if (LINT_RE.test(command)) return "lint";
	if (TYPECHECK_RE.test(command) && NO_EMIT_RE.test(command)) return "typecheck";
	return null;
}

/** Tokens that cannot be repo-local files: URLs, flags, assignments, env refs, packages. */
const NON_PATH_TOKEN = /^(?:https?:\/\/|[-$@]|\w+=)/;
/**
 * A repo-local path token always contains a slash (`./x`, `a/b.ts`,
 * `scripts/hooks/pre-commit`). Absolute paths (`/usr/bin/bash`) point outside
 * the repo and are deliberately excluded — they stay unverified.
 */
const PATH_TOKEN = /^\.?[\w.+-]+(?:\/[\w.+-]+)+\/?$/;

/**
 * Repo-local path references inside a command, normalized to repo-relative
 * POSIX form (leading `./` and `/` stripped, trailing `/` stripped), deduped
 * in order. Only the documented token shape is recognized; anything wrapped
 * in shell syntax (quotes are stripped; substitutions, globs, and command
 * separators are not paths) is skipped.
 */
export function extractLocalPaths(command: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const raw of command.split(/\s+/)) {
		const token = raw.replace(/^["']+/, "").replace(/["',;]+$/, "");
		if (token.length === 0 || NON_PATH_TOKEN.test(token) || !PATH_TOKEN.test(token)) continue;
		if (token.includes("://") || token.includes("..")) continue;
		const rel = token.replace(/^\.\//, "").replace(/\/$/, "");
		if (rel.length > 0 && !seen.has(rel)) {
			seen.add(rel);
			paths.push(rel);
		}
	}
	return paths;
}
