import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	npmNormalizationChanges,
	smokePackage,
	verifyPackedAssets,
	verifyPackedMetadata,
} from "./smoke-package.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("smokePackage", () => {
	test("packs the tarball and audits a fixture through the packed CLI", () => {
		const result = smokePackage(REPO_ROOT);
		expect(result.tarball).toEndWith(".tgz");
		expect(result.analyzerVersion).toBe("0.3.0");
		expect(result.scoreIndex).toBeGreaterThanOrEqual(0);
		expect(result.scoreIndex).toBeLessThanOrEqual(100);
	}, 30_000);
});

describe("verifyPackedMetadata", () => {
	test("accepts a package with the bin entry and analyzer dependencies", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-smoke-meta-"));
		try {
			mkdirSync(join(dir, "src/cli"), { recursive: true });
			writeFileSync(join(dir, "src/cli/main.ts"), "// bin\n");
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					bin: { trellis: "src/cli/main.ts" },
					dependencies: { commander: "1", "js-yaml": "1", typescript: "1", zod: "1" },
				}),
			);
			expect(() => verifyPackedMetadata(dir)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects a package whose bin target is not shipped", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-smoke-meta-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ bin: { trellis: "./src/cli/main.ts" }, dependencies: {} }),
			);
			expect(() => verifyPackedMetadata(dir)).toThrow(/bin\.trellis/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects a package missing analyzer runtime dependencies", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-smoke-meta-"));
		try {
			mkdirSync(join(dir, "src/cli"), { recursive: true });
			writeFileSync(join(dir, "src/cli/main.ts"), "// bin\n");
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ bin: { trellis: "src/cli/main.ts" }, dependencies: { commander: "1" } }),
			);
			expect(() => verifyPackedMetadata(dir)).toThrow(/typescript/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("npmNormalizationChanges (trellis-689e)", () => {
	test("flags a ./-prefixed bin target and a bare https repository url", () => {
		expect(
			npmNormalizationChanges({
				bin: { trellis: "./src/cli/main.ts" },
				repository: { type: "git", url: "https://github.com/o/r.git" },
			}),
		).toEqual([
			'bin[trellis] "./src/cli/main.ts" would be rewritten to "src/cli/main.ts"',
			'repository.url "https://github.com/o/r.git" would be normalized to "git+https://github.com/o/r.git"',
		]);
	});

	test("accepts the repository's own manifest unchanged", async () => {
		const manifest = await Bun.file(join(REPO_ROOT, "package.json")).json();
		expect(npmNormalizationChanges(manifest)).toEqual([]);
	});

	test("rejects a packed manifest npm would rewrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-smoke-meta-"));
		try {
			mkdirSync(join(dir, "src/cli"), { recursive: true });
			writeFileSync(join(dir, "src/cli/main.ts"), "// bin\n");
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					bin: { trellis: "./src/cli/main.ts" },
					dependencies: { commander: "1", "js-yaml": "1", typescript: "1", zod: "1" },
				}),
			);
			expect(() => verifyPackedMetadata(dir)).toThrow(/npm would rewrite/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifyPackedAssets", () => {
	test("rejects a package missing analyzer assets, naming each one", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-smoke-assets-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "package.json"), "{}");
			expect(() => verifyPackedAssets(dir)).toThrow(/src\/audit\/audit\.ts/);
			expect(() => verifyPackedAssets(dir)).toThrow(/src\/standards\/manifest\.yaml/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("accepts the repository's own source tree as the complete asset set", () => {
		expect(() => verifyPackedAssets(REPO_ROOT)).not.toThrow();
	});
});
