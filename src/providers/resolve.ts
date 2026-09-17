/**
 * The local resolver for pinned provider artifacts (SPEC §16.4, plan
 * `pl-43c5` — trellis-ff52): turn the supported-tool manifest
 * (`manifest.ts`) plus an operator-prepared local installation into a
 * verified executable path.
 *
 * - **Trellis-owned discovery only.** Resolution walks the `node_modules`
 *   chain upward from trellis's own module location — never PATH, never
 *   `bunx`/`npm exec`, never a target-workspace or operator-supplied command
 *   string, and never a network fetch. trellis never installs, updates, or
 *   downloads tools at audit time; it resolves only what is already
 *   installed.
 * - **Verify before use.** A resolved artifact is verified against its
 *   manifest entry — package name, exact version, bin layout, distribution
 *   file digests, platform-package identity, binary presence, and the
 *   platform binary digest where one is recorded. Any mismatch is a located
 *   `unavailable` result with actionable instructions, never a silently
 *   degraded run (§16.2/§16.3).
 * - **Honest hosts.** A host with no declared platform resolves
 *   `unsupported`; a declared-but-never-exercised platform resolves with
 *   `binaryDigestVerified: false` rather than claiming an unrecorded
 *   verification.
 *
 * This module never executes the tool (the controlled process runner,
 * `process.ts`, owns execution) and never writes anywhere.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
	type PinnedToolHost,
	type PinnedToolManifestEntry,
	type PinnedToolPlatform,
	pinnedTool,
	pinnedToolHost,
} from "./manifest.ts";

/** Where trellis resolves local installations from: its own module tree. */
const TRELLIS_MODULE_DIR = import.meta.dir;

/** Options for resolution; both slots default to the real environment and exist for tests. */
export interface PinnedToolResolveOptions {
	/** Directory whose `node_modules` chain is searched (default: trellis's own). */
	fromDir?: string;
	/** Host to resolve for (default: the real host). */
	host?: PinnedToolHost;
}

/** One resolution outcome: usable executable, or located failure with instructions. */
export type PinnedToolResolution =
	| {
			state: "available";
			providerId: string;
			executablePath: string;
			platformKey: string;
			toolVersion: string;
			binaryDigestVerified: boolean;
	  }
	| { state: "unavailable"; providerId: string; reason: string; instructions: string }
	| { state: "unsupported"; providerId: string; reason: string; instructions: string };

function unavailable(entry: PinnedToolManifestEntry, reason: string): PinnedToolResolution {
	return {
		state: "unavailable",
		providerId: entry.providerId,
		reason,
		instructions: entry.installInstructions,
	};
}

/** Walk the `node_modules` chain upward from `fromDir` for an installed package root. */
function findInstalledPackageRoot(packageName: string, fromDir: string): string | undefined {
	let current = fromDir;
	while (true) {
		const candidate = join(current, "node_modules", packageName);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Read a package.json, returning `undefined` when absent or malformed. */
function readPackageJson(root: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** The sha-256 of a file, or `undefined` when it cannot be read. */
function digestOf(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Whether `path` is an existing regular file. */
function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Verify the tool package's identity (name, exact version, bin layout); returns a failure reason. */
function verifyPackageIdentity(
	entry: PinnedToolManifestEntry,
	packageRoot: string,
	manifest: Record<string, unknown>,
): string | undefined {
	if (manifest.name !== entry.packageName) {
		return (
			`the package at ${packageRoot} reports name ${JSON.stringify(manifest.name)}, expected ` +
			`"${entry.packageName}" — refusing a mismatched artifact`
		);
	}
	if (manifest.version !== entry.pinnedVersion) {
		return (
			`the resolved ${entry.packageName} at ${packageRoot} is version ${JSON.stringify(manifest.version)}, ` +
			`but the pin is exactly ${entry.pinnedVersion} — trellis never installs, updates, or downgrades tools`
		);
	}
	const bin = manifest.bin;
	const binEntry =
		typeof bin === "object" && bin !== null
			? (bin as Record<string, unknown>)[entry.binCommand]
			: undefined;
	if (binEntry !== entry.binEntry) {
		return (
			`the resolved ${entry.packageName}@${entry.pinnedVersion} has bin.${entry.binCommand} ` +
			`${JSON.stringify(binEntry)}, expected ${JSON.stringify(entry.binEntry)}`
		);
	}
	return undefined;
}

/** Verify the pinned distribution's cross-platform file digests; returns a failure reason. */
function verifyDistributionDigests(
	entry: PinnedToolManifestEntry,
	packageRoot: string,
): string | undefined {
	const files = [
		[entry.launcherRelPath, entry.launcherSha256],
		[entry.platformMapRelPath, entry.platformMapSha256],
	] as const;
	for (const [relativePath, expected] of files) {
		const actual = digestOf(join(packageRoot, relativePath));
		if (actual !== expected) {
			return (
				`the resolved ${entry.packageName}@${entry.pinnedVersion} fails artifact verification: ` +
				`${relativePath} has sha-256 ${actual ?? "unreadable"}, expected ${expected} — the pinned ` +
				`distribution was modified or is not the pinned artifact`
			);
		}
	}
	return undefined;
}

/** The declared platform matching this host, or `undefined` when none is declared. */
function selectHostPlatform(
	entry: PinnedToolManifestEntry,
	host: PinnedToolHost,
): PinnedToolPlatform | undefined {
	return entry.platforms.find(
		(platform) =>
			platform.os === host.platform &&
			platform.cpu === host.arch &&
			(platform.libc ?? host.libc) === host.libc,
	);
}

function unsupportedHost(
	entry: PinnedToolManifestEntry,
	host: PinnedToolHost,
): PinnedToolResolution {
	return {
		state: "unsupported",
		providerId: entry.providerId,
		reason:
			`no pinned ${entry.providerId} platform binary is declared for ${host.platform}/${host.arch}` +
			`${host.libc === undefined ? "" : ` (${host.libc})`}; declared platforms: ` +
			`${entry.platforms.map((platform) => platform.key).join(", ")} — platforms beyond the ` +
			`exercised hosts are untested by trellis and claimed only as the tool ships them`,
		instructions: entry.installInstructions,
	};
}

/**
 * Resolve and verify the platform binary for the selected platform. Mirrors
 * the pinned launcher's own resolution: the platform package is a sibling of
 * the tool package in its (realpath) containing node_modules — anything
 * else is reported honestly instead of guessed.
 */
function resolvePlatformBinary(
	entry: PinnedToolManifestEntry,
	platform: PinnedToolPlatform,
	packageRoot: string,
): PinnedToolResolution {
	let resolvedRoot = packageRoot;
	try {
		resolvedRoot = realpathSync(packageRoot);
	} catch {
		// Keep the discovered root; the sibling checks below report honestly.
	}
	const platformRoot = join(dirname(resolvedRoot), platform.packageName);
	const manifest = readPackageJson(platformRoot);
	if (manifest === undefined || manifest.name !== platform.packageName) {
		return unavailable(
			entry,
			`the pinned platform package ${platform.packageName}@${entry.pinnedVersion} is not installed ` +
				`next to the resolved ${entry.packageName} (no matching package at ${platformRoot})`,
		);
	}
	if (manifest.version !== entry.pinnedVersion) {
		return unavailable(
			entry,
			`the resolved platform package ${platform.packageName} is version ` +
				`${JSON.stringify(manifest.version)}, but the pin is exactly ${entry.pinnedVersion}`,
		);
	}
	const binaryPath = join(platformRoot, platform.binaryRelPath);
	if (!isRegularFile(binaryPath)) {
		return unavailable(
			entry,
			`the resolved platform package ${platform.packageName}@${entry.pinnedVersion} has no ` +
				`${platform.binaryRelPath} binary at ${platformRoot}`,
		);
	}
	const binaryDigestVerified =
		platform.binarySha256 === undefined ? false : digestOf(binaryPath) === platform.binarySha256;
	if (platform.binarySha256 !== undefined && !binaryDigestVerified) {
		return unavailable(
			entry,
			`the ${platform.key} binary at ${binaryPath} fails artifact verification: its sha-256 does ` +
				`not match the digest recorded from the host that exercised this platform`,
		);
	}
	return {
		state: "available",
		providerId: entry.providerId,
		executablePath: binaryPath,
		platformKey: platform.key,
		toolVersion: entry.pinnedVersion,
		binaryDigestVerified,
	};
}

/**
 * Resolve one manifest entry against a local installation: discover the
 * pinned package from trellis's own resolution root, verify it against the
 * recorded artifact identity, and select the host's platform binary.
 */
export function resolvePinnedToolEntry(
	entry: PinnedToolManifestEntry,
	options: PinnedToolResolveOptions = {},
): PinnedToolResolution {
	const host = options.host ?? pinnedToolHost();
	const fromDir = options.fromDir ?? TRELLIS_MODULE_DIR;

	const packageRoot = findInstalledPackageRoot(entry.packageName, fromDir);
	if (packageRoot === undefined) {
		return unavailable(
			entry,
			`pinned tool "${entry.providerId}" (${entry.packageName}@${entry.pinnedVersion}) is not ` +
				`installed where trellis resolves from — no ${entry.packageName} package exists in the ` +
				`node_modules chain upward from ${fromDir}`,
		);
	}
	const manifest = readPackageJson(packageRoot);
	if (manifest === undefined) {
		return unavailable(
			entry,
			`the resolved ${entry.packageName} package at ${packageRoot} has no readable package.json`,
		);
	}
	const identityFailure = verifyPackageIdentity(entry, packageRoot, manifest);
	if (identityFailure !== undefined) {
		return unavailable(entry, identityFailure);
	}
	const digestFailure = verifyDistributionDigests(entry, packageRoot);
	if (digestFailure !== undefined) {
		return unavailable(entry, digestFailure);
	}
	const platform = selectHostPlatform(entry, host);
	if (platform === undefined) {
		return unsupportedHost(entry, host);
	}
	return resolvePlatformBinary(entry, platform, packageRoot);
}

/**
 * Resolve the pinned artifact for a known provider id against the real
 * environment. An unknown id is an operational error (SPEC §16.3): this
 * manifest pins artifacts only for providers trellis knows.
 */
export function resolvePinnedTool(
	providerId: string,
	options: PinnedToolResolveOptions = {},
): PinnedToolResolution {
	const entry = pinnedTool(providerId);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for provider id "${providerId}"`);
	}
	return resolvePinnedToolEntry(entry, options);
}

/** Resolution failures the executable seam reports (adapters translate them to evidence, §16.3). */
export class PinnedToolUnavailableError extends Error {
	readonly providerId: string;
	readonly resolution: Extract<PinnedToolResolution, { state: "unavailable" | "unsupported" }>;

	constructor(resolution: PinnedToolUnavailableError["resolution"]) {
		super(
			`pinned tool "${resolution.providerId}" is ${resolution.state}: ${resolution.reason} — ` +
				resolution.instructions,
		);
		this.name = "PinnedToolUnavailableError";
		this.providerId = resolution.providerId;
		this.resolution = resolution;
	}
}

/**
 * The verified absolute executable path for a pinned tool, for the
 * controlled process runner's executable registry. Throws
 * {@link PinnedToolUnavailableError} (carrying the located resolution) when
 * the pinned artifact is absent, mismatched, or unsupported on this host —
 * callers translate that into provider evidence, never a clean result
 * (§16.2/§16.3).
 */
export function requirePinnedToolExecutable(
	providerId: string,
	options: PinnedToolResolveOptions = {},
): string {
	const resolution = resolvePinnedTool(providerId, options);
	if (resolution.state !== "available") {
		throw new PinnedToolUnavailableError(resolution);
	}
	if (!isAbsolute(resolution.executablePath)) {
		throw new Error(`pinned tool "${providerId}" resolved a non-absolute path`);
	}
	return resolution.executablePath;
}
