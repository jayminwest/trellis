import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	type PinnedToolManifestEntry,
	pinnedToolHost,
	pinnedToolManifestEntrySchema,
} from "./manifest.ts";
import { resolveExecutable, runControlledProcess } from "./process.ts";
import {
	PinnedToolUnavailableError,
	requirePinnedToolExecutable,
	resolvePinnedTool,
	resolvePinnedToolEntry,
} from "./resolve.ts";

const TEMP_DIRS: string[] = [];
afterAll(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Canonical fixture bytes — the recorded digests always describe these, so overrides tamper. */
const CANONICAL_LAUNCHER = "launcher-fixture";
const CANONICAL_PLATFORM_MAP = "platform-map-fixture";
const CANONICAL_BINARY = "binary-fixture";

interface FixtureOverrides {
	toolVersion?: string;
	toolName?: string;
	binEntry?: string;
	launcherContent?: string;
	platformMapContent?: string;
	platformVersion?: string;
	binaryContent?: string;
	omitPlatformPackage?: boolean;
	omitBinary?: boolean;
	recordBinaryDigest?: boolean;
}

interface Fixture {
	root: string;
	entry: PinnedToolManifestEntry;
}

/** Build a hermetic synthetic pinned-tool installation plus its manifest entry. */
function writePinnedInstall(overrides: FixtureOverrides = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "trellis-pinned-")));
	TEMP_DIRS.push(root);
	const launcherContent = overrides.launcherContent ?? CANONICAL_LAUNCHER;
	const platformMapContent = overrides.platformMapContent ?? CANONICAL_PLATFORM_MAP;
	const binaryContent = overrides.binaryContent ?? CANONICAL_BINARY;
	const toolVersion = overrides.toolVersion ?? "1.2.3";
	const platformName = "fixture-linux-x64-gnu";

	const toolRoot = join(root, "node_modules", "fixture-tool");
	const platformRoot = join(root, "node_modules", platformName);
	mkdirSync(join(toolRoot), { recursive: true });
	if (!overrides.omitPlatformPackage) {
		mkdirSync(join(platformRoot, "bin"), { recursive: true });
	}
	writeFileSync(
		join(toolRoot, "package.json"),
		JSON.stringify({
			name: overrides.toolName ?? "fixture-tool",
			version: toolVersion,
			bin: { fixture: overrides.binEntry ?? "./run.js" },
		}),
	);
	writeFileSync(join(toolRoot, "run.js"), launcherContent);
	writeFileSync(join(toolRoot, "platform-map.js"), platformMapContent);
	if (!overrides.omitPlatformPackage) {
		writeFileSync(
			join(platformRoot, "package.json"),
			JSON.stringify({
				name: platformName,
				version: overrides.platformVersion ?? toolVersion,
			}),
		);
		if (!overrides.omitBinary) {
			writeFileSync(join(platformRoot, "bin", "fixture"), binaryContent);
		}
	}
	const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
	const entry = pinnedToolManifestEntrySchema.parse({
		providerId: "fixture-tool",
		packageName: "fixture-tool",
		pinnedVersion: "1.2.3",
		versionOutput: `fixture-tool 1.2.3`,
		binCommand: "fixture",
		binEntry: "./run.js",
		launcherRelPath: "run.js",
		platformMapRelPath: "platform-map.js",
		launcherSha256: digest(CANONICAL_LAUNCHER),
		platformMapSha256: digest(CANONICAL_PLATFORM_MAP),
		platforms: [
			{
				key: "linux-x64-gnu",
				packageName: platformName,
				os: "linux",
				cpu: "x64",
				libc: "glibc",
				binaryRelPath: "bin/fixture",
				execution: overrides.recordBinaryDigest === false ? "declared-untested" : "tested",
				evidence: "test fixture",
				...(overrides.recordBinaryDigest === false
					? {}
					: { binarySha256: digest(CANONICAL_BINARY) }),
			},
		],
		installInstructions: "fixture instructions: install fixture-tool@1.2.3 locally",
	});
	return { root, entry };
}

const LINUX_HOST = { platform: "linux", arch: "x64", libc: "glibc" as const };

describe("resolvePinnedToolEntry", () => {
	test("resolves and verifies a locally installed pinned artifact", () => {
		const { root, entry } = writePinnedInstall();
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution).toEqual({
			state: "available",
			providerId: "fixture-tool",
			executablePath: join(root, "node_modules", "fixture-linux-x64-gnu", "bin", "fixture"),
			platformKey: "linux-x64-gnu",
			toolVersion: "1.2.3",
			binaryDigestVerified: true,
		});
	});

	test("reports unavailable with instructions when the tool is not installed", () => {
		const root = mkdtempSync(join(tmpdir(), "trellis-pinned-empty-"));
		TEMP_DIRS.push(root);
		const { entry } = writePinnedInstall();
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution.state).toBe("unavailable");
		if (resolution.state !== "unavailable") return;
		expect(resolution.reason).toContain("node_modules chain upward from");
		expect(resolution.instructions).toContain("fixture-tool@1.2.3");
	});

	test("reports unavailable for a version-mismatched artifact instead of using it", () => {
		const { root, entry } = writePinnedInstall({ toolVersion: "9.9.9" });
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution.state).toBe("unavailable");
		if (resolution.state !== "unavailable") return;
		expect(resolution.reason).toContain("9.9.9");
		expect(resolution.reason).toContain("exactly 1.2.3");
		expect(resolution.reason).toContain("never installs, updates, or downgrades");
	});

	test("refuses a package whose name does not match the pin", () => {
		const { root, entry } = writePinnedInstall({ toolName: "impostor" });
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution.state).toBe("unavailable");
		if (resolution.state !== "unavailable") return;
		expect(resolution.reason).toContain("impostor");
		expect(resolution.reason).toContain("refusing a mismatched artifact");
	});

	test("refuses an unexpected bin layout", () => {
		const { root, entry } = writePinnedInstall({ binEntry: "./other.js" });
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution.state).toBe("unavailable");
		if (resolution.state !== "unavailable") return;
		expect(resolution.reason).toContain('bin.fixture "./other.js"');
	});

	test("refuses a modified launcher or platform map by digest", () => {
		for (const modified of [
			{ launcherContent: "tampered" },
			{ platformMapContent: "tampered" },
		] as const) {
			const { root, entry } = writePinnedInstall(modified);
			const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
			expect(resolution.state).toBe("unavailable");
			if (resolution.state !== "unavailable") continue;
			expect(resolution.reason).toContain("fails artifact verification");
		}
	});

	test("reports unavailable when the platform package is missing or mismatched", () => {
		for (const overrides of [
			{ omitPlatformPackage: true },
			{ platformVersion: "0.0.1" },
		] as const) {
			const { root, entry } = writePinnedInstall(overrides);
			const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
			expect(resolution.state).toBe("unavailable");
			if (resolution.state !== "unavailable") continue;
			expect(resolution.reason).toContain("fixture-linux-x64-gnu");
		}
	});

	test("reports unavailable when the platform binary is missing or fails its digest", () => {
		for (const overrides of [{ omitBinary: true }, { binaryContent: "tampered" }] as const) {
			const { root, entry } = writePinnedInstall(overrides);
			const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
			expect(resolution.state).toBe("unavailable");
			if (resolution.state !== "unavailable") continue;
			expect(resolution.reason).toContain("binary");
		}
	});

	test("resolves declared-untested platforms without claiming a digest verification", () => {
		const { root, entry } = writePinnedInstall({ recordBinaryDigest: false });
		const resolution = resolvePinnedToolEntry(entry, { fromDir: root, host: LINUX_HOST });
		expect(resolution).toEqual({
			state: "available",
			providerId: "fixture-tool",
			executablePath: join(root, "node_modules", "fixture-linux-x64-gnu", "bin", "fixture"),
			platformKey: "linux-x64-gnu",
			toolVersion: "1.2.3",
			binaryDigestVerified: false,
		});
	});

	test("reports unsupported hosts honestly instead of guessing a platform", () => {
		const { root, entry } = writePinnedInstall();
		const resolution = resolvePinnedToolEntry(entry, {
			fromDir: root,
			host: { platform: "linux", arch: "ia32", libc: "glibc" },
		});
		expect(resolution.state).toBe("unsupported");
		if (resolution.state !== "unsupported") return;
		expect(resolution.reason).toContain("linux/ia32");
		expect(resolution.reason).toContain("declared platforms: linux-x64-gnu");
		expect(resolution.reason).toContain("untested by trellis");
	});
});

describe("resolvePinnedTool", () => {
	test("throws for provider ids without a pinned artifact", () => {
		expect(() => resolvePinnedTool("sonarjs")).toThrow(
			/no pinned tool manifest entry for provider id "sonarjs"/,
		);
	});
});

describe("requirePinnedToolExecutable", () => {
	test("returns the verified absolute binary path for the pinned tool", () => {
		const path = requirePinnedToolExecutable("jscpd");
		expect(isAbsolute(path)).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	test("throws a located, instruction-carrying error when the artifact is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "trellis-pinned-absent-"));
		TEMP_DIRS.push(root);
		try {
			try {
				requirePinnedToolExecutable("jscpd", { fromDir: root });
				throw new Error("expected requirePinnedToolExecutable to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(PinnedToolUnavailableError);
				const unavailableError = error as PinnedToolUnavailableError;
				expect(unavailableError.resolution.state).toBe("unavailable");
				expect(unavailableError.message).toContain("bun install");
				expect(unavailableError.message).toContain("jscpd@5.2.1");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pinned jscpd against this repository's installation", () => {
	test("resolves the repository's pinned jscpd 5.2.1 artifact", () => {
		const resolution = resolvePinnedTool("jscpd");
		expect(resolution.state).toBe("available");
		if (resolution.state !== "available") return;
		const host = pinnedToolHost();
		if (host.platform === "linux") {
			expect(resolution.platformKey).toBe(
				`linux-${host.arch}-${host.libc === "musl" ? "musl" : "gnu"}`,
			);
		}
		expect(resolution.platformKey.length).toBeGreaterThan(0);
		expect(resolution.toolVersion).toBe("5.2.1");
		expect(existsSync(resolution.executablePath)).toBe(true);
	});

	test("invokes the pinned artifact offline through the controlled process runner", async () => {
		const executable = resolveExecutable("jscpd");
		expect(executable.id).toBe("jscpd");
		const result = await runControlledProcess(executable, {
			args: ["--version"],
			env: {},
			timeoutMs: 15_000,
			maxOutputBytes: 4096,
		});
		expect(result.outcome).toEqual({ kind: "exited", exitCode: 0 });
		expect(result.stdout.trim()).toBe("jscpd 5.2.1");
	}, 20_000);
});
