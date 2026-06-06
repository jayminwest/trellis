import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext } from "../../types.ts";
import {
	barrelFileReexportDetection,
	explicitAnyDetection,
	greppableExports,
	importCycleDetection,
	mutationTesting,
} from "./locality.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-swift-loc-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["swift"] });
}

describe("cross-language not-applicable mappings (SPEC §8.3)", () => {
	const cases: Array<[string, (ctx: DetectionContext) => Promise<{ naKind?: string }>]> = [
		["explicitAnyDetection", explicitAnyDetection],
		["greppableExports", greppableExports],
		["barrelFileReexportDetection", barrelFileReexportDetection],
		["importCycleDetection", importCycleDetection],
	];

	for (const [name, detector] of cases) {
		test(`${name} resolves not-applicable with a language-gap rationale`, async () => {
			const r = await detector(await repo({ "Package.swift": "// swift\n" }));
			expect(r.naKind).toBe("not-applicable");
			expect((r as { rationale: string }).rationale).toMatch(/no Swift analogue/i);
		});
	}
});

describe("mutationTesting", () => {
	test("passes with a muter config", async () => {
		expect((await mutationTesting(await repo({ "muter.conf.yml": "{}" }))).numerator).toBe(1);
	});

	test("passes when muter is wired via tooling", async () => {
		const r = await mutationTesting(await repo({ Makefile: "mutate:\n\tmuter run\n" }));
		expect(r.numerator).toBe(1);
	});

	test("not-applicable (skippable) when no mutation harness is configured", async () => {
		const r = await mutationTesting(await repo({ "Package.swift": "// swift\n" }));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
	});
});
