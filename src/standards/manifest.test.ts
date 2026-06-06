import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CANONICAL_SUFFIX,
	canonicalStoragePath,
	hashContent,
	loadManifest,
	MATCHER_KINDS,
	type Manifest,
	ManifestError,
	manifestFileSchema,
	manifestSchema,
	readCanonical,
	verifyManifest,
} from "./manifest.ts";

/** Write a YAML manifest to a fresh temp dir and return its path. */
function withManifest(yamlText: string): string {
	const dir = mkdtempSync(join(tmpdir(), "trellis-manifest-"));
	writeFileSync(join(dir, "manifest.yaml"), yamlText);
	return dir;
}

describe("loadManifest (bundled)", () => {
	test("loads and validates the real bundled manifest", () => {
		const manifest = loadManifest();
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.files.length).toBeGreaterThan(0);
	});

	test("starts the canonical set at version 1.0.0", () => {
		expect(loadManifest().version).toBe("1.0.0");
	});

	test("declares unique file paths", () => {
		const paths = loadManifest().files.map((f) => f.path);
		expect(new Set(paths).size).toBe(paths.length);
	});

	test("covers the SPEC §10 core canonical files", () => {
		const paths = new Set(loadManifest().files.map((f) => f.path));
		for (const required of [
			"biome.json",
			"tsconfig.base.json",
			".github/workflows/ci.yml",
			"AGENTS.md",
			"scripts/hooks/pre-commit",
			".seeds/config.yaml",
		]) {
			expect(paths.has(required)).toBe(true);
		}
	});
});

describe("verifyManifest (hash agreement)", () => {
	test("the bundled manifest hashes match the canonical files on disk", () => {
		const mismatches = verifyManifest(loadManifest());
		// Surface the offending paths if this fails so the fix is obvious.
		expect(mismatches).toEqual([]);
	});

	test("flags a recorded hash that disagrees with disk", () => {
		const manifest: Manifest = {
			version: "1.0.0",
			files: [
				{
					path: "biome.json",
					version: "1.0.0",
					hash: `sha256:${"0".repeat(64)}`,
					matcher: "json-subset",
				},
			],
		};
		const mismatches = verifyManifest(manifest);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0]?.path).toBe("biome.json");
		expect(mismatches[0]?.actual).not.toBe(mismatches[0]?.expected);
	});

	test("reports a missing canonical file as actual:null", () => {
		const manifest: Manifest = {
			version: "1.0.0",
			files: [
				{
					path: "does-not-exist.json",
					version: "1.0.0",
					hash: `sha256:${"a".repeat(64)}`,
					matcher: "exact",
				},
			],
		};
		const mismatches = verifyManifest(manifest);
		expect(mismatches).toEqual([
			{ path: "does-not-exist.json", expected: `sha256:${"a".repeat(64)}`, actual: null },
		]);
	});
});

describe("matcher kinds", () => {
	test("every bundled file uses a known matcher kind", () => {
		for (const file of loadManifest().files) {
			expect(MATCHER_KINDS).toContain(file.matcher);
		}
	});

	test("the bundled set exercises every matcher kind (coverage)", () => {
		const used = new Set(loadManifest().files.map((f) => f.matcher));
		for (const kind of MATCHER_KINDS) {
			expect(used.has(kind)).toBe(true);
		}
	});
});

describe("manifest schema", () => {
	test("rejects a non-semver set version", () => {
		const result = manifestSchema.safeParse({ version: "1.0", files: [] });
		expect(result.success).toBe(false);
	});

	test("requires at least one file", () => {
		const result = manifestSchema.safeParse({ version: "1.0.0", files: [] });
		expect(result.success).toBe(false);
	});

	test("rejects an unknown matcher kind", () => {
		const result = manifestFileSchema.safeParse({
			path: "biome.json",
			version: "1.0.0",
			hash: `sha256:${"0".repeat(64)}`,
			matcher: "fuzzy",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a malformed hash digest", () => {
		const result = manifestFileSchema.safeParse({
			path: "biome.json",
			version: "1.0.0",
			hash: "deadbeef",
			matcher: "exact",
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown top-level key", () => {
		const result = manifestSchema.safeParse({
			version: "1.0.0",
			files: [],
			extra: true,
		});
		expect(result.success).toBe(false);
	});

	test("rejects a path that escapes the canonical dir", () => {
		const result = manifestFileSchema.safeParse({
			path: "../secret",
			version: "1.0.0",
			hash: `sha256:${"0".repeat(64)}`,
			matcher: "exact",
		});
		expect(result.success).toBe(false);
	});
});

describe("loadManifest (errors)", () => {
	test("throws ManifestError when the manifest is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-manifest-"));
		try {
			expect(() => loadManifest(dir)).toThrow(ManifestError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws ManifestError on a schema violation", () => {
		const dir = withManifest("version: nope\nfiles: []\n");
		try {
			expect(() => loadManifest(dir)).toThrow(ManifestError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws ManifestError on a duplicate file path", () => {
		const entry = (matcher: string) =>
			`  - path: biome.json\n    version: "1.0.0"\n    hash: "sha256:${"0".repeat(64)}"\n    matcher: ${matcher}\n`;
		const dir = withManifest(`version: "1.0.0"\nfiles:\n${entry("json-subset")}${entry("exact")}`);
		try {
			expect(() => loadManifest(dir)).toThrow(/duplicate file path/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("canonical storage layout", () => {
	test("storage path applies the .canon suffix", () => {
		expect(canonicalStoragePath("biome.json")).toEndWith(`biome.json${CANONICAL_SUFFIX}`);
	});

	test("every bundled file is readable and matches its recorded hash", () => {
		for (const file of loadManifest().files) {
			expect(hashContent(readCanonical(file.path))).toBe(file.hash);
		}
	});
});

describe("hashContent", () => {
	test("emits a sha256:-prefixed 64-hex digest", () => {
		expect(hashContent("")).toBe(
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	test("is stable across string and byte inputs", () => {
		expect(hashContent("trellis")).toBe(hashContent(new TextEncoder().encode("trellis")));
	});
});
