import { describe, expect, test } from "bun:test";
import {
	type KnipProviderRequest,
	knipProviderRequestSchema,
	MAX_REACHABILITY_ENTRY_FILES,
	MAX_REACHABILITY_EXPORT_NAME_LENGTH,
	MAX_REACHABILITY_PATH_LENGTH,
	MAX_REACHABILITY_PUBLIC_SURFACES,
} from "./reachability-policy.ts";

describe("knipProviderRequestSchema (trellis-5da5 — declarative reachability context)", () => {
	test("accepts the empty request unchanged — no key is required, no root is guessed", () => {
		const parsed = knipProviderRequestSchema.parse({});
		expect(parsed).toEqual({});
	});

	test("round-trips a full declaration: entries, public surfaces and test participation", () => {
		const request: KnipProviderRequest = {
			entries: ["src/cli/main.ts", "scripts/check-all.ts"],
			public: [{ path: "src/index.ts" }, { path: "src/client/index.ts", export: "audit" }],
			tests: "roots",
		};
		expect(knipProviderRequestSchema.parse(request)).toEqual(request);
	});

	test("accepts a file as both an entry and a public surface — a package index is both", () => {
		const request = { entries: ["src/index.ts"], public: [{ path: "src/index.ts" }] };
		expect(knipProviderRequestSchema.parse(request)).toEqual(request);
	});

	test("accepts the same surface file with a file-level and an export-level declaration", () => {
		const request = {
			public: [{ path: "src/index.ts" }, { path: "src/index.ts", export: "audit" }],
		};
		expect(knipProviderRequestSchema.parse(request)).toEqual(request);
	});

	test("keeps the test-participation vocabulary closed — no invented mode parses", () => {
		for (const tests of ["include", "all", "yes", ""]) {
			expect(knipProviderRequestSchema.safeParse({ tests }).success).toBe(false);
		}
		expect(knipProviderRequestSchema.parse({ tests: "excluded" }).tests).toBe("excluded");
	});

	test("rejects plugin vocabulary actionably — discovery is never declarable (AC4)", () => {
		for (const request of [
			{ vite: true },
			{ plugins: ["vite", "next"] },
			{ "playwright-test": false },
			{ entry: ["src/main.ts"] },
			{ project: ["src/**/*.ts"] },
		]) {
			const parsed = knipProviderRequestSchema.safeParse(request);
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				// The unknown key names itself in the message — plugin and tool-config
				// vocabulary is rejected actionably, never reinterpreted.
				expect(parsed.error.issues[0]?.message).toContain(Object.keys(request)[0]);
			}
		}
	});

	test("rejects a pasted executable knip config — the shape cannot parse", () => {
		const pasted = {
			entry: ["src/main.ts"],
			project: ["src/**/*.ts"],
			ignore: ["**/*.test.ts"],
			ignoreDependencies: ["bun-types"],
		};
		expect(knipProviderRequestSchema.safeParse(pasted).success).toBe(false);
	});

	test("rejects duplicate entries — an ambiguous declaration is a config error", () => {
		const parsed = knipProviderRequestSchema.safeParse({
			entries: ["src/main.ts", "src/util.ts", "src/main.ts"],
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.path).toEqual(["entries", 2]);
			expect(parsed.error.issues[0]?.message).toContain("declared twice");
		}
	});

	test("rejects duplicate public surfaces — including the same named export twice", () => {
		for (const request of [
			{ public: [{ path: "src/index.ts" }, { path: "src/index.ts" }] },
			{
				public: [
					{ path: "src/index.ts", export: "audit" },
					{ path: "src/index.ts", export: "audit" },
				],
			},
		]) {
			expect(knipProviderRequestSchema.safeParse(request).success).toBe(false);
		}
	});

	test("rejects invalid entry paths — a declaration stays inside the audited root", () => {
		for (const path of [
			"/src/main.ts",
			"../outside/main.ts",
			"src\\main.ts",
			"",
			"C:/src/main.ts",
			"src//main.ts",
		]) {
			expect(knipProviderRequestSchema.safeParse({ entries: [path] }).success).toBe(false);
		}
	});

	test("rejects over-length paths — declarations are bounded", () => {
		const long = `src/${"a".repeat(MAX_REACHABILITY_PATH_LENGTH)}.ts`;
		expect(knipProviderRequestSchema.safeParse({ entries: [long] }).success).toBe(false);
	});

	test("rejects non-identifier and over-length export names", () => {
		for (const exportName of ["not-an-identifier", "1starts-with-digit", "has space", ""]) {
			expect(
				knipProviderRequestSchema.safeParse({
					public: [{ path: "src/index.ts", export: exportName }],
				}).success,
			).toBe(false);
		}
		const long = "a".repeat(MAX_REACHABILITY_EXPORT_NAME_LENGTH + 1);
		expect(
			knipProviderRequestSchema.safeParse({ public: [{ path: "src/index.ts", export: long }] })
				.success,
		).toBe(false);
	});

	test("rejects over-long lists — the declared context stays finite", () => {
		const entries = Array.from(
			{ length: MAX_REACHABILITY_ENTRY_FILES + 1 },
			(_, i) => `src/e${i}.ts`,
		);
		expect(knipProviderRequestSchema.safeParse({ entries }).success).toBe(false);
		const publicSurfaces = Array.from({ length: MAX_REACHABILITY_PUBLIC_SURFACES + 1 }, (_, i) => ({
			path: `src/s${i}.ts`,
		}));
		expect(knipProviderRequestSchema.safeParse({ public: publicSurfaces }).success).toBe(false);
	});

	test("rejects unknown keys inside a public surface — the surface vocabulary is closed", () => {
		const parsed = knipProviderRequestSchema.safeParse({
			public: [{ path: "src/index.ts", exports: ["audit"] }],
		});
		expect(parsed.success).toBe(false);
	});
});
