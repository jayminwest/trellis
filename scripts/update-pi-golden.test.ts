import { describe, expect, test } from "bun:test";
import type { PiProcessHandle, PiSpawn } from "../src/investigation/provider/index.ts";
import {
	assertCaptureAllowed,
	capturingSpawn,
	GoldenGateError,
	type GoldenRegenOptions,
	main,
	parseGoldenArgs,
	UPDATE_ENV_VAR,
} from "./update-pi-golden.ts";

/**
 * The regeneration script is the one place that can make a live model call, so
 * its double gate (env flag + `--live`) is the load-bearing guarantee that CI
 * never does. These tests pin the gate and the capture plumbing without ever
 * spawning `pi`.
 */

function opts(over: Partial<GoldenRegenOptions> = {}): GoldenRegenOptions {
	return { update: false, live: false, repo: "/repo", ...over };
}

describe("parseGoldenArgs", () => {
	test("reads the env flag, --live, --area, and --repo", () => {
		const parsed = parseGoldenArgs(["--live", "--area", "documentation", "--repo", "/r"], {
			[UPDATE_ENV_VAR]: "1",
		} as NodeJS.ProcessEnv);
		expect(parsed).toEqual({ update: true, live: true, area: "documentation", repo: "/r" });
	});

	test("defaults: no flags → not updatable, all areas, env-derived repo", () => {
		const parsed = parseGoldenArgs([], { PWD: "/here" } as NodeJS.ProcessEnv);
		expect(parsed.update).toBe(false);
		expect(parsed.live).toBe(false);
		expect(parsed.area).toBeUndefined();
		expect(parsed.repo).toBe("/here");
	});

	test("rejects an unknown --area", () => {
		expect(() => parseGoldenArgs(["--area", "bogus"], {} as NodeJS.ProcessEnv)).toThrow(
			GoldenGateError,
		);
	});
});

describe("assertCaptureAllowed", () => {
	test("passes only when both the env flag and --live are present", () => {
		expect(() => assertCaptureAllowed(opts({ update: true, live: true }))).not.toThrow();
	});

	test("refuses without --live, naming the missing gate", () => {
		expect(() => assertCaptureAllowed(opts({ update: true, live: false }))).toThrow("--live");
	});

	test("refuses without the env flag, naming it", () => {
		expect(() => assertCaptureAllowed(opts({ update: false, live: true }))).toThrow(UPDATE_ENV_VAR);
	});

	test("refuses with neither gate (the CI default)", () => {
		const err = (() => {
			try {
				assertCaptureAllowed(opts());
				return null;
			} catch (e) {
				return e as Error;
			}
		})();
		expect(err).toBeInstanceOf(GoldenGateError);
		expect(err?.message).toContain("CI never calls a model");
	});
});

describe("main (gate enforcement, no spawn)", () => {
	test("exits non-zero and prints the refusal when ungated — never spawns pi", async () => {
		const code = await main([], {} as NodeJS.ProcessEnv);
		expect(code).toBe(1);
	});

	test("a bad --area is reported as a gate error, not a crash", async () => {
		const code = await main(["--area", "nope"], { [UPDATE_ENV_VAR]: "1" } as NodeJS.ProcessEnv);
		expect(code).toBe(1);
	});
});

describe("capturingSpawn", () => {
	test("tees stdout into the chunk sink while passing a live stream to the session", async () => {
		const encoder = new TextEncoder();
		const line = '{"type":"agent_end"}\n';
		const base: PiSpawn = () => {
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode(line));
					c.close();
				},
			});
			const handle: PiProcessHandle = {
				stdout,
				writeStdin() {},
				closeStdin() {},
				kill() {},
				exited: Promise.resolve(0),
			};
			return handle;
		};
		const chunks: Uint8Array[] = [];
		const handle = capturingSpawn(base, chunks)({ argv: ["pi"], env: {}, cwd: "/" });
		// Drain the session-facing branch so the tee makes progress.
		const reader = handle.stdout.getReader();
		let seen = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		expect(seen).toBe(line);
		// Allow the capture branch's async drain to flush.
		await new Promise((r) => setTimeout(r, 5));
		const captured = chunks.map((c) => new TextDecoder().decode(c)).join("");
		expect(captured).toBe(line);
	});
});
