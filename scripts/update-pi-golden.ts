#!/usr/bin/env bun
/**
 * Investigation golden regeneration (SPEC §9.7) — operator-only.
 *
 * Re-records the frozen `pi --mode rpc` session per area under
 * `src/investigation/__golden__/`. Capture makes **real model calls**, so it is
 * double-gated: it refuses unless BOTH the `TRELLIS_UPDATE_PI_GOLDEN=1` env flag
 * AND an explicit `--live` argument are present. This is the guarantee that CI —
 * which sets neither — can never trigger a model call through this script.
 *
 * When allowed, each area is investigated through the real provider path
 * (`investigate()` with the real `defaultPiSpawn`), the raw stdout stream is
 * teed off into a buffer, canonicalized via {@link canonicalizePiStream}, and
 * written to the area's golden file. Volatile fields collapse to fixed
 * placeholders so the diff is the facts that changed, not session noise.
 *
 * Usage:
 *   TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live
 *   TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live --area documentation
 *   TRELLIS_UPDATE_PI_GOLDEN=1 bun run scripts/update-pi-golden.ts --live --repo /path/to/repo
 *
 * Without the gates it prints the refusal and exits non-zero. The frozen
 * fixtures it overwrites are otherwise hand-authored (see
 * `src/investigation/__golden__/README.md`).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AREA_IDS, type AreaId } from "../src/investigation/areas.ts";
import { canonicalizePiStream, GOLDEN_DIR, goldenFileName } from "../src/investigation/golden.ts";
import {
	defaultPiSpawn,
	investigate,
	type PiProcessHandle,
	type PiSpawn,
} from "../src/investigation/provider/index.ts";

/** Env flag that, with `--live`, unlocks live capture. */
export const UPDATE_ENV_VAR = "TRELLIS_UPDATE_PI_GOLDEN";

/** Resolved invocation options. */
export interface GoldenRegenOptions {
	/** `TRELLIS_UPDATE_PI_GOLDEN=1` is set. */
	readonly update: boolean;
	/** The explicit `--live` argument is present. */
	readonly live: boolean;
	/** A single area to regenerate (default: all four). */
	readonly area?: AreaId;
	/** Repo to investigate (default: cwd). */
	readonly repo: string;
}

/** Thrown when the double gate is not satisfied (caught in `main`, never crashes CI). */
export class GoldenGateError extends Error {}

/** Parse argv + env into {@link GoldenRegenOptions} (pure; throws on a bad `--area`). */
export function parseGoldenArgs(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
): GoldenRegenOptions {
	let live = false;
	let area: AreaId | undefined;
	let repo = env.PWD ?? process.cwd();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--live") live = true;
		else if (arg === "--area") {
			const value = argv[++i];
			if (!value || !(AREA_IDS as readonly string[]).includes(value)) {
				throw new GoldenGateError(`--area must be one of: ${AREA_IDS.join(", ")}`);
			}
			area = value as AreaId;
		} else if (arg === "--repo") {
			const value = argv[++i];
			if (!value) throw new GoldenGateError("--repo requires a path");
			repo = value;
		}
	}
	return { update: env[UPDATE_ENV_VAR] === "1", live, area, repo };
}

/**
 * Enforce the double gate. Throws {@link GoldenGateError} with an actionable
 * message unless both `TRELLIS_UPDATE_PI_GOLDEN=1` and `--live` are present —
 * the structural reason CI cannot make a model call here.
 */
export function assertCaptureAllowed(opts: GoldenRegenOptions): void {
	if (opts.update && opts.live) return;
	const missing: string[] = [];
	if (!opts.update) missing.push(`${UPDATE_ENV_VAR}=1`);
	if (!opts.live) missing.push("--live");
	throw new GoldenGateError(
		`refusing to capture goldens: live capture makes real model calls and requires ${missing.join(" and ")}. ` +
			"This gate is why CI never calls a model.",
	);
}

/**
 * Wrap a {@link PiSpawn} so every stdout chunk is also pushed into `chunks`,
 * recording the raw session stream while the session loop drives it normally.
 */
export function capturingSpawn(base: PiSpawn, chunks: Uint8Array[]): PiSpawn {
	return (ctx) => {
		const handle = base(ctx);
		const [forSession, forCapture] = handle.stdout.tee();
		void (async () => {
			const reader = forCapture.getReader();
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
		})();
		const wrapped: PiProcessHandle = { ...handle, stdout: forSession };
		return wrapped;
	};
}

/** Decode captured stdout chunks into one string. */
function decodeChunks(chunks: readonly Uint8Array[]): string {
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

/** Capture one area live, canonicalize, and freeze its golden file. */
async function regenerateArea(area: AreaId, repo: string): Promise<void> {
	const chunks: Uint8Array[] = [];
	const result = await investigate(repo, area, { spawn: capturingSpawn(defaultPiSpawn, chunks) });
	if (!result.ok) {
		throw new Error(`area "${area}" did not produce findings: ${result.reason}`);
	}
	const raw = decodeChunks(chunks);
	const canonical = canonicalizePiStream(raw);
	writeFileSync(join(GOLDEN_DIR, goldenFileName(area)), canonical);
	console.error(`captured ${goldenFileName(area)} (${canonical.length} bytes)`);
}

/** CLI entrypoint — gated; returns a process exit code. */
export async function main(
	argv: readonly string[] = Bun.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	let opts: GoldenRegenOptions;
	try {
		opts = parseGoldenArgs(argv, env);
		assertCaptureAllowed(opts);
	} catch (err) {
		if (err instanceof GoldenGateError) {
			console.error(err.message);
			return 1;
		}
		throw err;
	}
	const areas = opts.area ? [opts.area] : [...AREA_IDS];
	for (const area of areas) await regenerateArea(area, opts.repo);
	console.error(`regenerated ${areas.length} golden(s) from ${opts.repo}`);
	return 0;
}

if (import.meta.main) process.exit(await main());
