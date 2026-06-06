import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import { largeFileDetection, preCommitHooks, techDebtTracking } from "./quality.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-qual-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("largeFileDetection", () => {
	test("passes via a check:size script that runs a file-size ratchet", async () => {
		expect(
			(
				await largeFileDetection(
					await repo({
						"package.json": '{"scripts":{"check:size":"bun run scripts/check-file-sizes.ts"}}',
					}),
				)
			).numerator,
		).toBe(1);
	});

	test("passes via a ratchet script file", async () => {
		expect(
			(await largeFileDetection(await repo({ "scripts/check-file-sizes.ts": "x" }))).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) without a budget", async () => {
		const r = await largeFileDetection(await repo({ "package.json": "{}" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("techDebtTracking", () => {
	test("passes via a check:debt script", async () => {
		expect(
			(await techDebtTracking(await repo({ "package.json": '{"scripts":{"check:debt":"x"}}' })))
				.numerator,
		).toBe(1);
	});

	test("fails without debt tracking", async () => {
		expect((await techDebtTracking(await repo({}))).numerator).toBe(0);
	});
});

describe("preCommitHooks", () => {
	test("passes with a .pre-commit-config.yaml", async () => {
		expect(
			(await preCommitHooks(await repo({ ".pre-commit-config.yaml": "repos: []" }))).numerator,
		).toBe(1);
	});

	test("passes via core.hooksPath wired to a committed hook", async () => {
		const r = await preCommitHooks(
			await repo({
				"package.json": '{"scripts":{"prepare":"git config core.hooksPath scripts/hooks"}}',
				"scripts/hooks/pre-commit": "#!/bin/sh\n",
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes via a husky declaration", async () => {
		expect((await preCommitHooks(await repo({ ".husky/pre-commit": "x" }))).numerator).toBe(1);
	});

	test("fails (non-skippable) with no hook setup", async () => {
		const r = await preCommitHooks(await repo({ "package.json": "{}" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});
