/**
 * Pinned provider artifacts (SPEC §16.4, trellis-ff52): exact versions,
 * launcher/package digests and verified host execution records.
 * `resolve.ts` verifies operator-prepared local tools; `process.ts` runs
 * them. This manifest never installs, downloads or executes anything.
 * Pin changes require fresh digests/conformance and change evidence
 * identity, never the native scoring basis. See docs/provider-tools.md.
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
		const packageNames = new Map<string, boolean>();
		const hosts = new Set<string>();
		for (const platform of entry.platforms) {
			if (keys.has(platform.key)) {
				ctx.addIssue({ code: "custom", message: `duplicate platform key "${platform.key}"` });
			}
			keys.add(platform.key);
			// A JavaScript distribution shares its verified launcher across hosts.
			// Native platform packages still must be unique (trellis-b18d).
			const isSharedLauncher =
				platform.packageName === entry.packageName &&
				platform.binaryRelPath === entry.launcherRelPath &&
				platform.binarySha256 === entry.launcherSha256;
			const permitsSharedPackage =
				isSharedLauncher && packageNames.get(platform.packageName) === true;
			if (packageNames.has(platform.packageName) && !permitsSharedPackage) {
				ctx.addIssue({
					code: "custom",
					message: `duplicate platform package "${platform.packageName}"`,
				});
			}
			packageNames.set(platform.packageName, isSharedLauncher);
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
		{
			/**
			 * dependency-cruiser 18.3.1 (plan `pl-43c5` step 22, trellis-adbf) is a
			 * **pure-JavaScript** distribution: its "binary" is the launcher script
			 * `bin/dependency-cruiser.mjs` itself, and the platform package of every
			 * declared host is the tool package — there is no platform map. The two
			 * cross-platform distribution files the pin verifies are therefore the
			 * launcher and the package manifest. The adapter executes the launcher
			 * under trellis's own runtime through the controlled process runner
			 * (`src/providers/dependency-cruiser/invocation.ts`); the tool resolves its
			 * own TypeScript parser locally, and the adapter records that parser's
			 * version per run (the research record: a missing parser produced a
			 * successful empty graph — docs/research/architecture-provider-spike).
			 */
			providerId: "dependency-cruiser",
			packageName: "dependency-cruiser",
			pinnedVersion: "18.3.1",
			versionOutput: "18.3.1",
			binCommand: "dependency-cruiser",
			binEntry: "bin/dependency-cruiser.mjs",
			launcherRelPath: "bin/dependency-cruiser.mjs",
			platformMapRelPath: "package.json",
			launcherSha256: "3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6",
			platformMapSha256: "6aed892071cdd9ebca9517665d19a67ded18510f64a608beb611f711623c6cbd",
			platforms: [
				{
					key: "darwin-arm64",
					packageName: "dependency-cruiser",
					os: "darwin",
					cpu: "arm64",
					binaryRelPath: "bin/dependency-cruiser.mjs",
					execution: "tested",
					evidence:
						"macOS 26.5.2 ARM64, Bun 1.3.14: dependency-cruiser conformance and " +
						"cross-provider suites passed; docs/provider-acceptance.md (trellis-b18d)",
					binarySha256: "3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6",
				},
				{
					key: "linux-x64-gnu",
					packageName: "dependency-cruiser",
					os: "linux",
					cpu: "x64",
					libc: "glibc",
					binaryRelPath: "bin/dependency-cruiser.mjs",
					execution: "tested",
					evidence:
						"src/providers/dependency-cruiser conformance suite + scripts/smoke-provider-tools.ts " +
						"(plan pl-43c5 step 22, trellis-adbf)",
					binarySha256: "3a57384034c8b33016761ea022df1a9f1476f187a8c250573ccdcf301d169ba6",
				},
			],
			installInstructions:
				"prepare the pinned tool locally where trellis resolves from (never at audit time): " +
				"run `bun install` in this repository (dependency-cruiser 18.3.1 is a pinned " +
				"devDependency, alongside a local typescript install it can resolve as its parser), or " +
				"in the package tree a trellis CLI install runs from run `npm install --save-exact " +
				"--save-dev dependency-cruiser@18.3.1` / `bun add --dev dependency-cruiser@18.3.1`; trellis " +
				"then discovers and verifies the artifact offline (SPEC §16.4)",
		},
		{
			/**
			 * Knip 6.16.1 (plan `pl-43c5` step 24, trellis-8ebc) is a
			 * **pure-JavaScript** distribution that ships a dedicated Bun
			 * launcher (`bin/knip-bun.js`) — the artifact the pin verifies and
			 * the adapter executes under trellis's own runtime through the
			 * controlled process runner (`src/providers/knip/invocation.ts`).
			 * Like dependency-cruiser there is no platform map: the platform
			 * package of every declared host is the tool package itself, and
			 * the two cross-platform distribution files the pin verifies are
			 * the launcher and the package manifest. Knip is also this
			 * repository's own `check:deps` gate tool, so the pin reuses the
			 * exact version already installed as a devDependency — never a
			 * second copy — and the gate keeps working against it.
			 */
			providerId: "knip",
			packageName: "knip",
			pinnedVersion: "6.16.1",
			versionOutput: "6.16.1",
			binCommand: "knip-bun",
			binEntry: "bin/knip-bun.js",
			launcherRelPath: "bin/knip-bun.js",
			platformMapRelPath: "package.json",
			launcherSha256: "0decd26eef37578c2574b6a83f711f19775ca04c132fb89049a23e9cecb80388",
			platformMapSha256: "331cb6aa29cf65ff754257ba01aee8c695f3dbf836d2539722a20771cb55a272",
			platforms: [
				{
					key: "darwin-arm64",
					packageName: "knip",
					os: "darwin",
					cpu: "arm64",
					binaryRelPath: "bin/knip-bun.js",
					execution: "tested",
					evidence:
						"macOS ARM64: conformance, failure, combined surface and offline acceptance " +
						"passed with oxc-parser 0.133.0; docs/provider-acceptance.md (trellis-639c)",
					binarySha256: "0decd26eef37578c2574b6a83f711f19775ca04c132fb89049a23e9cecb80388",
				},
				{
					key: "linux-x64-gnu",
					packageName: "knip",
					os: "linux",
					cpu: "x64",
					libc: "glibc",
					binaryRelPath: "bin/knip-bun.js",
					execution: "tested",
					evidence:
						"src/providers/knip conformance suite + scripts/smoke-provider-tools.ts " +
						"(plan pl-43c5 step 24, trellis-8ebc)",
					binarySha256: "0decd26eef37578c2574b6a83f711f19775ca04c132fb89049a23e9cecb80388",
				},
			],
			installInstructions:
				"prepare the pinned tool locally where trellis resolves from (never at audit time): " +
				"run `bun install` in this repository (knip 6.16.1 is a pinned devDependency — the same " +
				"install this repository's own check:deps gate uses), or in the package tree a trellis " +
				"CLI install runs from run `npm install --save-exact --save-dev knip@6.16.1` / `bun add " +
				"--dev knip@6.16.1`; trellis then discovers and verifies the artifact offline (SPEC §16.4)",
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
