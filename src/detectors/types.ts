/**
 * Detector contract (SPEC §8.1) — the deterministic HOW layer's boundary.
 *
 * A {@link Detector} is a pure-ish async function: given a read-only
 * {@link DetectionContext} over one app, it returns a {@link DetectorResult}
 * (pass / fail / N-A) for one criterion. The result's `naKind` encodes the §3.2
 * discipline — `not-applicable` for an honestly-absent surface (excluded from
 * coverage) vs `no-detector` for should-have-measured-but-couldn't (drags
 * coverage down). Build results only via the {@link pass}/{@link fail}/
 * {@link notApplicable}/{@link noDetector} helpers so the contract (denominator
 * = 1, ≤500-char rationale, numerator↔naKind biconditional) always holds.
 *
 * `NaKind` / `MAX_RATIONALE` are re-used from the scorer so the detector layer
 * and the scorecard agree on the same §3.2 / §6.2 vocabulary.
 */
import { z } from "zod";
import { MAX_RATIONALE, NA_KINDS, type NaKind } from "../scoring/index.ts";

export { MAX_RATIONALE, NA_KINDS, type NaKind } from "../scoring/index.ts";

/** Languages with a detector adapter in the MVP (SPEC §8.3). */
export const LANGUAGES = ["typescript", "swift", "python"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Result of a sandboxed subprocess run via {@link DetectionContext.run}. */
export interface ExecResult {
	/** Process exit code; `127` when the command could not be spawned (tool missing). */
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when the run was killed for exceeding its timeout. */
	timedOut: boolean;
}

/**
 * Read-only view of one app, handed to every detector (SPEC §8.1). File and
 * process operations are rooted at the app directory (`repoPath`/`app.path`);
 * repo-scope criteria run with `app.path === "."`. There is deliberately no
 * write surface here — the read-only mandate is enforced by the absence of an
 * API, not by trust.
 */
export interface DetectionContext {
	/** Absolute path to the target repo root. */
	repoPath: string;
	/** The app under audit; `path` is repo-relative (`.` for repo-scope). */
	app: { path: string; languages: Language[] };
	/** Spawn a subprocess sandboxed to the app cwd, with a timeout. Never throws. */
	run: (argv: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
	/** Read a file relative to the app root; `null` if absent or outside the repo. */
	readFile: (rel: string) => Promise<string | null>;
	/** Glob relative to the app root; returns repo-relative-to-app matches. */
	glob: (pattern: string) => Promise<string[]>;
}

/**
 * One criterion's measurement for one app (SPEC §8.1). `denominator` is always
 * `1` (the per-app unit; the aggregator rolls N apps up). `numerator` is `1`
 * (pass) / `0` (fail) / `null` (N-A); `naKind` is present exactly when null.
 */
export interface DetectorResult {
	numerator: number | null;
	denominator: 1;
	naKind?: NaKind;
	rationale: string;
}

/** A deterministic detector: read-only context in, one criterion result out. */
export type Detector = (ctx: DetectionContext) => Promise<DetectorResult>;

/**
 * zod schema enforcing the §8.1 invariants: denominator literal `1`, numerator
 * `0|1|null`, `naKind` present iff numerator is null, ≤500-char rationale.
 */
export const detectorResultSchema = z
	.strictObject({
		numerator: z.union([z.literal(0), z.literal(1), z.null()]),
		denominator: z.literal(1),
		naKind: z.enum(NA_KINDS).optional(),
		rationale: z.string().min(1).max(MAX_RATIONALE),
	})
	.superRefine((r, ctx) => {
		if (r.numerator === null && r.naKind === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "naKind is required when numerator is null (N/A)",
				path: ["naKind"],
			});
		}
		if (r.numerator !== null && r.naKind !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "naKind must be absent when numerator is non-null",
				path: ["naKind"],
			});
		}
	});

/** Clamp a rationale to the ≤500-char contract, marking truncation. */
function clampRationale(rationale: string): string {
	if (rationale.length <= MAX_RATIONALE) return rationale;
	return `${rationale.slice(0, MAX_RATIONALE - 1)}…`;
}

/** A passing measurement (`numerator: 1`). */
export function pass(rationale: string): DetectorResult {
	return { numerator: 1, denominator: 1, rationale: clampRationale(rationale) };
}

/** A failing measurement (`numerator: 0`). */
export function fail(rationale: string): DetectorResult {
	return { numerator: 0, denominator: 1, rationale: clampRationale(rationale) };
}

/**
 * Honestly-absent surface (SPEC §3.2): the criterion does not apply to this app
 * (no DB, no declared apps, concept absent for the language). **Excluded** from
 * the coverage base — a narrow repo is not penalized for what it correctly lacks.
 */
export function notApplicable(reason: string): DetectorResult {
	return {
		numerator: null,
		denominator: 1,
		naKind: "not-applicable",
		rationale: clampRationale(reason),
	};
}

/**
 * Should-have-measured-but-couldn't (SPEC §3.2): missing adapter, tool not
 * installed, or ambiguous evidence. **Counted against** coverage so it drags the
 * score down — the honest signal that trellis owes this repo a real check.
 */
export function noDetector(reason: string): DetectorResult {
	return {
		numerator: null,
		denominator: 1,
		naKind: "no-detector",
		rationale: clampRationale(reason),
	};
}
