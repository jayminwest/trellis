/**
 * lint / typecheck / test script inspection (SPEC §5.5, trellis-a97d).
 *
 * The surface is the root manifest's `scripts` map. A script counts for a
 * check kind when its **body** contains a recognizable check invocation
 * (documented in `shell.ts`) — the script *name* is irrelevant, so custom
 * names like `check:lint` qualify through wiring, and named-tool dependency
 * presence (`devDependencies.eslint`) never counts on its own.
 *
 * Evidence rules:
 *
 * - no manifest → `absent`; an unparseable manifest → `unknown` for all three;
 * - a matching script exists → `configured`, located at its package.json line;
 * - the matching script is reachable from a CI `run:` step (directly, or
 *   transitively through documented `run` references), or CI invokes the same
 *   check command itself → `structurally-wired`;
 * - reachability stops at executable runners (`bun scripts/check-all.ts`):
 *   their internal behavior is unverified, so a check reachable only through
 *   one stays `configured` with an explanatory note.
 */
import { type CheckKind, recognizeCheck } from "./shell.ts";
import type { SafeguardContext, ScriptEntry, SurfaceEvidence } from "./types.ts";
import { ciDirectChecks, ciReachableScripts, describeReach, type Reach } from "./wiring.ts";

/** The safeguard id and human label per check kind. */
export const CHECK_KINDS: readonly { kind: CheckKind; id: string; label: string }[] = [
	{ kind: "lint", id: "lint-script", label: "lint" },
	{ kind: "typecheck", id: "typecheck-script", label: "typecheck" },
	{ kind: "test", id: "test-script", label: "test" },
];

/** Scripts whose body invokes `kind`, in manifest order. */
function matchingScripts(scripts: readonly ScriptEntry[], kind: CheckKind): ScriptEntry[] {
	return scripts.filter((script) => recognizeCheck(script.body) === kind);
}

/** The executable-runner scripts that block transitive wiring (for notes). */
function runnerScripts(scripts: readonly ScriptEntry[], reach: Map<string, Reach>): string[] {
	return scripts
		.filter((s) => reach.has(s.name) && /\b(?:bun|node)\s+\S+\.[cm]?[jt]s\b/.test(s.body))
		.map((s) => s.name)
		.sort();
}

/** Inspect one check kind against the shared context. */
export function inspectCheckScript(ctx: SafeguardContext, kind: CheckKind): SurfaceEvidence {
	if (ctx.manifest === null) return { level: "absent", locations: [], notes: [], findings: [] };
	if (ctx.manifest.parseError !== undefined) {
		return {
			level: "unknown",
			locations: [{ path: ctx.manifest.path }],
			notes: [`${ctx.manifest.path} is unparseable (${ctx.manifest.parseError})`],
			findings: [],
		};
	}
	const matches = matchingScripts(ctx.manifest.scripts, kind);
	if (matches.length === 0) {
		return {
			level: "absent",
			locations: [],
			notes: ["dependency or tool-config presence alone is not evidence"],
			findings: [],
		};
	}
	const locations = matches.map((script) => ({
		path: ctx.manifest?.path ?? "package.json",
		range: { start: { line: script.line }, end: { line: script.line } },
	}));
	const reach = ciReachableScripts(ctx);
	const wired = matches.find((script) => reach.has(script.name));
	const wiredReach = wired !== undefined ? reach.get(wired.name) : undefined;
	const directCi = ciDirectChecks(ctx).has(kind);
	if (wired !== undefined && wiredReach !== undefined) {
		const note = `referenced from CI (${describeReach(wired.name, wiredReach)})`;
		return { level: "structurally-wired", locations, notes: [note], findings: [] };
	}
	if (directCi) {
		return {
			level: "structurally-wired",
			locations,
			notes: ["CI invokes the same check command directly"],
			findings: [],
		};
	}
	const notes = ["no CI workflow references the script"];
	const runners = runnerScripts(ctx.manifest.scripts, reach);
	if (runners.length > 0) {
		notes.push(
			`CI reaches executable runner(s) ${runners.join(", ")}; runner behavior is unverified`,
		);
	}
	return { level: "configured", locations, notes, findings: [] };
}
