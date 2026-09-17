/**
 * The supported-tool manifest (SPEC §16.4, plan `pl-43c5` — trellis-ff52):
 * the pinned record of every external provider artifact trellis may execute
 * — exact package version, bin layout, and SHA-256 digests of the pinned
 * distribution's cross-platform files (plus each platform binary's digest
 * wherever a real host produced one) — together with the honesty record for
 * every declared platform host.
 *
 * Resolution and verification live in `resolve.ts`; execution lives in the
 * controlled process runner (`process.ts`). Nothing here runs, installs,
 * updates, or downloads a tool — the operator prepares the installation
 * (this repository pins jscpd as a devDependency, so `bun install` prepares
 * the exact artifact offline), and trellis only ever discovers and verifies
 * what is already local (SPEC §16.4 "Trust boundary — supported
 * installation"; no audit-time acquisition, ever).
 *
 * The pinned tool version is part of provider/analysis identity (§16.2), so
 * changing a pin changes evidence identity — it never silently trends
 * (§16.6). An upgrade is a manifest change with fresh digests and fresh
 * platform execution records, not a runtime resolution.
 */
import { z } from "zod";
import { providerIdSchema } from "../contract/index.ts";
import { SUPPORTED_PROVIDERS } from "./capabilities.ts";

const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha-256 hex digest");
const exactVersionSchema = z
	.string()
	.regex(/^\d+\.\d+\.\d+$/, "must be an exact version — ranges are forbidden");

/** How a declared platform's installation and invocation were exercised. */
export const PINNED_TOOL_EXECUTION_RECORDS = [
	"tested",
	"research-tested",
	"declared-untested",
] as const;
export type PinnedToolExecutionRecord = (typeof PINNED_TOOL_EXECUTION_RECORDS)[number];

/**
 * One declared platform of a pinned tool: the platform package that ships
 * its binary, the host shape it matches, and the honest record of how (and
 * whether) trellis exercised it. A binary digest may only be recorded where
 * a real host exercised the platform, and an exercised host must record one
 * — no fabricated digests, no unbacked claims.
 */
export const pinnedToolPlatformSchema = z
	.strictObject({
		key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
		packageName: z.string().min(1),
		os: z.string().min(1),
		cpu: z.string().min(1),
		libc: z.enum(["glibc", "musl"]).optional(),
		binaryRelPath: z.string().min(1),
		execution: z.enum(PINNED_TOOL_EXECUTION_RECORDS),
		evidence: z.string().min(1),
		binarySha256: hex64Schema.optional(),
	})
	.superRefine((platform, ctx) => {
		const isWindows = platform.os === "win32";
		if (isWindows !== platform.binaryRelPath.endsWith(".exe")) {
			ctx.addIssue({
				code: "custom",
				message: "win32 platform binaries must end in .exe and no other may",
				path: ["binaryRelPath"],
			});
		}
		if ((platform.execution !== "declared-untested") !== (platform.binarySha256 !== undefined)) {
			ctx.addIssue({
				code: "custom",
				message:
					"a binary digest may only be recorded where a real host exercised the platform, and an exercised host must record one",
				path: ["binarySha256"],
			});
		}
	});
export type PinnedToolPlatform = z.infer<typeof pinnedToolPlatformSchema>;

/** One pinned external tool: its identity, expected artifact identity, and platforms. */
export const pinnedToolManifestEntrySchema = z
	.strictObject({
		providerId: providerIdSchema,
		packageName: z.string().min(1),
		pinnedVersion: exactVersionSchema,
		/** The exact stdout the tool's `--version` must report (verified at invocation). */
		versionOutput: z.string().min(1),
		binCommand: z.string().min(1),
		binEntry: z.string().min(1),
		launcherRelPath: z.string().min(1),
		platformMapRelPath: z.string().min(1),
		launcherSha256: hex64Schema,
		platformMapSha256: hex64Schema,
		platforms: z.array(pinnedToolPlatformSchema).min(1),
		installInstructions: z.string().min(1),
	})
	.superRefine((entry, ctx) => {
		if (!entry.versionOutput.includes(entry.pinnedVersion)) {
			ctx.addIssue({
				code: "custom",
				message: "versionOutput must report the pinned version",
				path: ["versionOutput"],
			});
		}
		const keys = new Set<string>();
		const packageNames = new Set<string>();
		const hosts = new Set<string>();
		for (const platform of entry.platforms) {
			if (keys.has(platform.key)) {
				ctx.addIssue({ code: "custom", message: `duplicate platform key "${platform.key}"` });
			}
			keys.add(platform.key);
			if (packageNames.has(platform.packageName)) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate platform package "${platform.packageName}"`,
				});
			}
			packageNames.add(platform.packageName);
			const host = `${platform.os}/${platform.cpu}/${platform.libc ?? "any"}`;
			if (hosts.has(host)) {
				ctx.addIssue({ code: "custom", message: `duplicate host ${host}` });
			}
			hosts.add(host);
		}
	});
export type PinnedToolManifestEntry = z.infer<typeof pinnedToolManifestEntrySchema>;

/**
 * The pinned-tool manifest. jscpd 5.2.1 is pinned as a devDependency of this
 * repository; digests were recorded from the real npm distribution
 * (run-jscpd.js / platform-map.js are cross-platform files) and from
 * exercised hosts: linux-x64-gnu by this step's package-install smoke,
 * darwin-arm64 by the research spike
 * (docs/research/jscpd-provider-spike/summary.json). The remaining declared
 * platforms ship in jscpd@5.2.1's optionalDependencies but were never
 * executed by trellis — recorded `declared-untested`, with no digest.
 */
export const PINNED_TOOLS: readonly PinnedToolManifestEntry[] = (() => {
	const table: readonly PinnedToolManifestEntry[] = [
		{
			providerId: "jscpd",
			packageName: "jscpd",
			pinnedVersion: "5.2.1",
			versionOutput: "jscpd 5.2.1",
			binCommand: "jscpd",
			binEntry: "./run-jscpd.js",
			launcherRelPath: "run-jscpd.js",
			platformMapRelPath: "platform-map.js",
			launcherSha256: "e81342e628de62d9b15fe94a918d25cc98e2e90a9b85c3f8ec636578c278467a",
			platformMapSha256: "ad6f2a21dfcae532d675125663cd349fac478f220334e34d3a90bc6d3fe28b2a",
			platforms: [
				{
					key: "linux-x64-gnu",
					packageName: "jscpd-linux-x64-gnu",
					os: "linux",
					cpu: "x64",
					libc: "glibc",
					binaryRelPath: "bin/jscpd",
					execution: "tested",
					evidence: "scripts/smoke-provider-tools.ts (plan pl-43c5 step 11)",
					binarySha256: "26d613a8ca8cb276dd50721f98c7695e8b6449bd03b9e0568570c824e9c407f2",
				},
				{
					key: "darwin-arm64",
					packageName: "jscpd-darwin-arm64",
					os: "darwin",
					cpu: "arm64",
					binaryRelPath: "bin/jscpd",
					execution: "research-tested",
					evidence: "docs/research/jscpd-provider-spike/summary.json (trellis-ff55)",
					binarySha256: "272c2833e2dcff607058cdfb9a4b27db3a772759400ceaaf9ce2e67d3c764d23",
				},
				{
					key: "linux-arm64-gnu",
					packageName: "jscpd-linux-arm64-gnu",
					os: "linux",
					cpu: "arm64",
					libc: "glibc",
					binaryRelPath: "bin/jscpd",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
				{
					key: "linux-x64-musl",
					packageName: "jscpd-linux-x64-musl",
					os: "linux",
					cpu: "x64",
					libc: "musl",
					binaryRelPath: "bin/jscpd",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
				{
					key: "linux-arm64-musl",
					packageName: "jscpd-linux-arm64-musl",
					os: "linux",
					cpu: "arm64",
					libc: "musl",
					binaryRelPath: "bin/jscpd",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
				{
					key: "darwin-x64",
					packageName: "jscpd-darwin-x64",
					os: "darwin",
					cpu: "x64",
					binaryRelPath: "bin/jscpd",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
				{
					key: "windows-x64-msvc",
					packageName: "jscpd-windows-x64-msvc",
					os: "win32",
					cpu: "x64",
					binaryRelPath: "bin/jscpd.exe",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
				{
					key: "windows-arm64-msvc",
					packageName: "jscpd-windows-arm64-msvc",
					os: "win32",
					cpu: "arm64",
					binaryRelPath: "bin/jscpd.exe",
					execution: "declared-untested",
					evidence: "declared by jscpd@5.2.1 platform-map.js; never executed by trellis",
				},
			],
			installInstructions:
				"prepare the pinned tool locally where trellis resolves from (never at audit time): " +
				"run `bun install` in this repository (jscpd 5.2.1 is a pinned devDependency), or in the " +
				"package tree a trellis CLI install runs from run `npm install --save-exact --save-dev " +
				"jscpd@5.2.1` / `bun add --dev jscpd@5.2.1`; trellis then discovers and verifies the " +
				"artifact offline (SPEC §16.4)",
		},
	];
	const validated = z.array(pinnedToolManifestEntrySchema).parse(table);
	for (const entry of validated) {
		if (!SUPPORTED_PROVIDERS.some((provider) => provider.providerId === entry.providerId)) {
			throw new Error(`pinned tool "${entry.providerId}" is not a known supported provider`);
		}
	}
	return validated;
})();

/** The manifest entry for `providerId`; `undefined` when no artifact is pinned. */
export function pinnedTool(providerId: string): PinnedToolManifestEntry | undefined {
	return PINNED_TOOLS.find((entry) => entry.providerId === providerId);
}

/** The host trellis resolves platform binaries for. */
export interface PinnedToolHost {
	platform: string;
	arch: string;
	libc: "glibc" | "musl" | undefined;
}

/**
 * Detect the linux libc flavor, mirroring the pinned launcher's own
 * `platform-map.js` rule: glibc when the runtime report carries a glibc
 * version, musl otherwise (including a report that cannot be read).
 */
export function detectLinuxLibc(
	getReport: () => unknown = () => process.report?.getReport(),
	platform: NodeJS.Platform = process.platform,
): "glibc" | "musl" | undefined {
	if (platform !== "linux") return undefined;
	try {
		const report = getReport() as { header?: { glibcVersionRuntime?: string } } | null;
		return report?.header?.glibcVersionRuntime !== undefined ? "glibc" : "musl";
	} catch {
		return "musl";
	}
}

/** The current host's platform/architecture (and libc flavor on linux). */
export function pinnedToolHost(): PinnedToolHost {
	return { platform: process.platform, arch: process.arch, libc: detectLinuxLibc() };
}
