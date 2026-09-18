import { describe, expect, test } from "bun:test";
import { isKnownProviderId } from "./capabilities.ts";
import {
	detectLinuxLibc,
	PINNED_TOOL_EXECUTION_RECORDS,
	PINNED_TOOLS,
	pinnedTool,
	pinnedToolHost,
	pinnedToolManifestEntrySchema,
} from "./manifest.ts";

describe("manifest", () => {
	test("pins exactly one known provider artifact per entry", () => {
		for (const entry of PINNED_TOOLS) {
			expect(isKnownProviderId(entry.providerId)).toBe(true);
			expect(entry.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
		}
		expect(PINNED_TOOLS.map((entry) => entry.providerId)).toEqual([
			"jscpd",
			"dependency-cruiser",
			"knip",
		]);
	});

	test("pins jscpd 5.2.1 with its real distribution digests", () => {
		const jscpd = pinnedTool("jscpd");
		expect(jscpd?.pinnedVersion).toBe("5.2.1");
		expect(jscpd?.versionOutput).toBe("jscpd 5.2.1");
		expect(jscpd?.launcherSha256).toBe(
			"e81342e628de62d9b15fe94a918d25cc98e2e90a9b85c3f8ec636578c278467a",
		);
		expect(jscpd?.platformMapSha256).toBe(
			"ad6f2a21dfcae532d675125663cd349fac478f220334e34d3a90bc6d3fe28b2a",
		);
	});

	test("pins dependency-cruiser 18.3.1, a pure-JavaScript distribution, with its real digests", () => {
		const dependencyCruiser = pinnedTool("dependency-cruiser");
		expect(dependencyCruiser?.pinnedVersion).toBe("18.3.1");
		expect(dependencyCruiser?.versionOutput).toBe("18.3.1");
		// The launcher is the "binary" of every declared platform; the package
		// manifest is the second cross-platform identity file (no platform map
		// ships — see the manifest entry's own record).
		expect(dependencyCruiser?.launcherSha256).toBe(
			"3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6",
		);
		expect(dependencyCruiser?.platformMapSha256).toBe(
			"6aed892071cdd9ebca9517665d19a67ded18510f64a608beb611f711623c6cbd",
		);
		expect(dependencyCruiser?.platforms).toEqual([
			{
				key: "linux-x64-gnu",
				packageName: "dependency-cruiser",
				os: "linux",
				cpu: "x64",
				libc: "glibc",
				binaryRelPath: "bin/dependency-cruiser.mjs",
				execution: "tested",
				evidence: expect.stringContaining("trellis-adbf"),
				binarySha256: "3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6",
			},
		]);
	});

	test("records platform availability honestly, exercised hosts only carrying digests", () => {
		const jscpd = pinnedTool("jscpd");
		expect(jscpd).toBeDefined();
		if (jscpd === undefined) return;
		const byKey = new Map(jscpd.platforms.map((platform) => [platform.key, platform]));
		expect(byKey.get("linux-x64-gnu")?.execution).toBe("tested");
		expect(byKey.get("darwin-arm64")?.execution).toBe("research-tested");
		expect(byKey.get("darwin-x64")?.execution).toBe("declared-untested");
		expect(byKey.get("windows-x64-msvc")?.binarySha256).toBeUndefined();
		for (const platform of jscpd.platforms) {
			expect(PINNED_TOOL_EXECUTION_RECORDS).toContain(platform.execution);
			expect(platform.evidence.length).toBeGreaterThan(0);
			if (platform.execution === "declared-untested") {
				expect(platform.binarySha256).toBeUndefined();
			} else {
				expect(platform.binarySha256).toMatch(/^[0-9a-f]{64}$/);
			}
		}
	});

	test("gives every failure path actionable install instructions", () => {
		const jscpd = pinnedTool("jscpd");
		expect(jscpd).toBeDefined();
		if (jscpd === undefined) return;
		expect(jscpd.installInstructions).toContain("jscpd@5.2.1");
		expect(jscpd.installInstructions).toContain("never at audit time");
	});

	test("pins knip 6.16.1, a pure-JavaScript distribution, with its real digests", () => {
		const knip = pinnedTool("knip");
		expect(knip?.pinnedVersion).toBe("6.16.1");
		expect(knip?.versionOutput).toBe("6.16.1");
		// The Bun launcher is the "binary" of every declared platform; the
		// package manifest is the second cross-platform identity file (no
		// platform map ships — see the manifest entry's own record). The pin
		// reuses the exact devDependency install this repository's own
		// check:deps gate runs — never a second copy.
		expect(knip?.binCommand).toBe("knip-bun");
		expect(knip?.binEntry).toBe("bin/knip-bun.js");
		expect(knip?.launcherSha256).toBe(
			"0decd26eef37578c2574b6a83f711f19775ca04c132fb89049a23e9cecb80388",
		);
		expect(knip?.platformMapSha256).toBe(
			"331cb6aa29cf65ff754257ba01aee8c695f3dbf836d2539722a20771cb55a272",
		);
		expect(knip?.platforms).toEqual([
			{
				key: "linux-x64-gnu",
				packageName: "knip",
				os: "linux",
				cpu: "x64",
				libc: "glibc",
				binaryRelPath: "bin/knip-bun.js",
				execution: "tested",
				evidence: expect.stringContaining("trellis-8ebc"),
				binarySha256: "0decd26eef37578c2574b6a83f711f19775ca04c132fb89049a23e9cecb80388",
			},
		]);
		expect(knip?.installInstructions).toContain("knip@6.16.1");
		expect(knip?.installInstructions).toContain("never at audit time");
	});

	test("returns undefined for unpinned provider ids", () => {
		expect(pinnedTool("sonarjs")).toBeUndefined();
	});

	test("rejects entries that claim a digest without exercising the platform", () => {
		const jscpd = pinnedTool("jscpd");
		expect(jscpd).toBeDefined();
		if (jscpd === undefined) return;
		const first = jscpd.platforms[0];
		if (first === undefined) return;
		const fabricated = { ...jscpd, platforms: [{ ...first, binarySha256: undefined }] };
		const result = pinnedToolManifestEntrySchema.safeParse(fabricated);
		expect(result.success).toBe(false);
	});

	test("rejects version ranges as pins", () => {
		const jscpd = pinnedTool("jscpd");
		expect(jscpd).toBeDefined();
		if (jscpd === undefined) return;
		const ranged = { ...jscpd, pinnedVersion: "^5.2.1" };
		expect(pinnedToolManifestEntrySchema.safeParse(ranged).success).toBe(false);
	});
});

describe("detectLinuxLibc", () => {
	test("reports glibc from a runtime report that carries a glibc version", () => {
		expect(detectLinuxLibc(() => ({ header: { glibcVersionRuntime: "2.36" } }), "linux")).toBe(
			"glibc",
		);
	});

	test("reports musl when the runtime report carries no glibc version", () => {
		expect(detectLinuxLibc(() => ({ header: {} }), "linux")).toBe("musl");
		expect(detectLinuxLibc(() => null, "linux")).toBe("musl");
	});

	test("reports musl when the runtime report cannot be read", () => {
		expect(
			detectLinuxLibc(() => {
				throw new Error("report unavailable");
			}, "linux"),
		).toBe("musl");
	});

	test("leaves libc unspecified on non-Linux hosts without reading the report", () => {
		for (const platform of ["darwin", "win32"] as const) {
			let wasRead = false;
			expect(
				detectLinuxLibc(() => {
					wasRead = true;
					return { header: { glibcVersionRuntime: "2.36" } };
				}, platform),
			).toBeUndefined();
			expect(wasRead).toBe(false);
		}
	});

	test("reports the host's real platform and architecture", () => {
		const host = pinnedToolHost();
		expect(host.platform).toBe(process.platform);
		expect(host.arch).toBe(process.arch);
		if (process.platform === "linux") {
			expect(host.libc === "glibc" || host.libc === "musl").toBe(true);
		}
	});
});
