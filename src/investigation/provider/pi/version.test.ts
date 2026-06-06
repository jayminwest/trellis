import { describe, expect, test } from "bun:test";
import {
	MIN_SUPPORTED_PI_VERSION,
	parseSemver,
	probePiVersion,
	semverGte,
	type VersionSpawn,
} from "./version.ts";

const fakeSpawn = (exitCode: number, stdout: string): VersionSpawn => {
	return async () => ({ exitCode, stdout });
};

describe("parseSemver", () => {
	test("extracts a triple from noisy --version output", () => {
		expect(parseSemver("pi version 0.74.0 (build abc)")).toEqual([0, 74, 0]);
		expect(parseSemver("0.78.1")).toEqual([0, 78, 1]);
	});

	test("returns null when no version is present", () => {
		expect(parseSemver("not a version")).toBeNull();
	});
});

describe("semverGte", () => {
	test("compares triples component-wise", () => {
		expect(semverGte([0, 78, 1], [0, 74, 0])).toBe(true);
		expect(semverGte([0, 74, 0], [0, 74, 0])).toBe(true);
		expect(semverGte([0, 73, 9], [0, 74, 0])).toBe(false);
		expect(semverGte([1, 0, 0], [0, 99, 99])).toBe(true);
	});
});

describe("probePiVersion", () => {
	test("accepts a Pi at or above the supported minimum", async () => {
		const probe = await probePiVersion({ spawn: fakeSpawn(0, "0.78.1") });
		expect(probe).toEqual({ ok: true, version: "0.78.1" });
	});

	test("accepts exactly the supported minimum", async () => {
		const probe = await probePiVersion({ spawn: fakeSpawn(0, MIN_SUPPORTED_PI_VERSION) });
		expect(probe.ok).toBe(true);
	});

	test("rejects a missing binary (non-zero exit) with a hint", async () => {
		const probe = await probePiVersion({ spawn: fakeSpawn(127, "") });
		expect(probe.ok).toBe(false);
		if (!probe.ok) {
			expect(probe.reason).toContain("exited 127");
			expect(probe.hint).toContain("pi-coding-agent");
		}
	});

	test("rejects an incompatible (too old) Pi", async () => {
		const probe = await probePiVersion({ spawn: fakeSpawn(0, "0.50.0") });
		expect(probe.ok).toBe(false);
		if (!probe.ok) expect(probe.reason).toContain("below the supported minimum");
	});

	test("rejects unparseable version output", async () => {
		const probe = await probePiVersion({ spawn: fakeSpawn(0, "garbage") });
		expect(probe.ok).toBe(false);
		if (!probe.ok) expect(probe.reason).toContain("could not parse");
	});
});
