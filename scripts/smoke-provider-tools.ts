#!/usr/bin/env bun
/**
 * Pinned provider-tool package smoke (trellis-ff52, plan pl-43c5 step 11,
 * SPEC §16.4): exercise the installation side of the supported-tool
 * manifest against this repository and invoke the pinned artifact offline.
 *
 *   1. **Pin isolation** — every pinned tool is an exact devDependency of
 *      this repository (installed offline by `bun install`) and is absent
 *      from the native runtime `dependencies`, so optional provider assets
 *      never enter the packed CLI's native core.
 *   2. **Lockfile pin** — bun.lock carries the exact pinned version, so the
 *      prepared artifact is reproducible, not "whatever resolves today".
 *   3. **Offline discovery + verification + invocation** — each pinned tool
 *      resolves from the repository's own installation through the
 *      trellis-owned manifest/resolver (never PATH, never `bunx`, never a
 *      download) and, when the host is supported, runs `--version` through
 *      the controlled process runner and must report exactly the pinned
 *      version output. Absent or host-unsupported artifacts fail loudly with
 *      the resolver's located reason and instructions (SPEC §16.3) — this
 *      smoke runs on the declared supported host targets only.
 *
 *   bun run scripts/smoke-provider-tools.ts   # exit 0 on success, 1 on failure
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	dependencyCruiserEnvironment,
	pinnedLauncherInvocation,
} from "../src/providers/dependency-cruiser/invocation.ts";
import { PINNED_TOOLS } from "../src/providers/manifest.ts";
import { resolveExecutable, runControlledProcess } from "../src/providers/process.ts";
import { resolvePinnedTool } from "../src/providers/resolve.ts";

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "..");

interface RepoPackageJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function readRepoPackageJson(repoRoot: string): RepoPackageJson {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as RepoPackageJson;
}

/**
 * Every pinned tool must be an exact devDependency (never a runtime
 * dependency, never a range) — the operator-prepared local installation
 * this repository dogfoods, isolated from the native core.
 */
export function verifyPinnedToolPin(
	packageJson: RepoPackageJson,
): { tool: string; pinnedVersion: string }[] {
	const pinned: { tool: string; pinnedVersion: string }[] = [];
	for (const entry of PINNED_TOOLS) {
		const devPin = packageJson.devDependencies?.[entry.packageName];
		if (devPin !== entry.pinnedVersion) {
			throw new Error(
				`pinned tool ${entry.packageName} must be an exact devDependency ` +
					`"${entry.pinnedVersion}" (found ${JSON.stringify(devPin)}) — ranges and runtime ` +
					`dependencies are forbidden (SPEC §16.4, trellis-ff52)`,
			);
		}
		if (packageJson.dependencies?.[entry.packageName] !== undefined) {
			throw new Error(
				`pinned tool ${entry.packageName} leaked into native runtime dependencies — optional ` +
					`provider assets must stay isolated from the packed CLI core`,
			);
		}
		pinned.push({ tool: entry.packageName, pinnedVersion: entry.pinnedVersion });
	}
	return pinned;
}

/** The lockfile must carry the exact pin, so installs are reproducible offline. */
export function verifyLockfilePin(lockText: string): void {
	for (const entry of PINNED_TOOLS) {
		if (!lockText.includes(`"${entry.packageName}": "${entry.pinnedVersion}"`)) {
			throw new Error(
				`bun.lock does not pin ${entry.packageName} at exactly ${entry.pinnedVersion} — the ` +
					`prepared artifact would not be reproducible`,
			);
		}
	}
}

export interface ProviderToolSmokeResult {
	pinned: { tool: string; pinnedVersion: string }[];
	invoked: { providerId: string; platformKey: string; versionOutput: string }[];
}

/**
 * How one pinned tool's `--version` check is invoked: platform-binary tools
 * run their own resolved executable; pure-JavaScript distributions (the
 * dependency-cruiser launcher) run under trellis's own runtime through the
 * same controlled runner, with the pinned launcher path as an inert first
 * argument — never a PATH lookup (src/providers/dependency-cruiser/
 * invocation.ts owns the composition).
 */
function versionInvocation(entry: (typeof PINNED_TOOLS)[number]): {
	executable: ReturnType<typeof resolveExecutable>;
	args: string[];
	env: Record<string, string>;
} {
	if (entry.providerId === "dependency-cruiser") {
		const resolution = resolvePinnedTool(entry.providerId);
		if (resolution.state !== "available") {
			throw new Error(
				`pinned tool "${entry.providerId}" did not resolve on this host (${resolution.state}): ` +
					`${resolution.reason} — ${resolution.instructions}`,
			);
		}
		const invocation = pinnedLauncherInvocation(resolution);
		return {
			executable: invocation.interpreter,
			args: [invocation.launcher.path, "--version"],
			env: dependencyCruiserEnvironment("/trellis-owned-smoke-home"),
		};
	}
	return { executable: resolveExecutable(entry.providerId), args: ["--version"], env: {} };
}

/** Verify the pins, then resolve and invoke every pinned tool offline. */
export async function smokeProviderTools(
	repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<ProviderToolSmokeResult> {
	const pinned = verifyPinnedToolPin(readRepoPackageJson(repoRoot));
	verifyLockfilePin(readFileSync(join(repoRoot, "bun.lock"), "utf8"));

	const invoked: ProviderToolSmokeResult["invoked"] = [];
	for (const entry of PINNED_TOOLS) {
		const resolution = resolvePinnedTool(entry.providerId);
		if (resolution.state !== "available") {
			throw new Error(
				`pinned tool "${entry.providerId}" did not resolve on this host (${resolution.state}): ` +
					`${resolution.reason} — ${resolution.instructions}`,
			);
		}
		const { executable, args, env } = versionInvocation(entry);
		const result = await runControlledProcess(executable, {
			args,
			env,
			timeoutMs: 15_000,
			maxOutputBytes: 4096,
		});
		if (result.outcome.kind !== "exited" || result.outcome.exitCode !== 0) {
			throw new Error(
				`pinned ${entry.providerId} --version did not exit 0 (${result.outcome.kind}: ` +
					`${result.stderr.trim() || result.stdout.trim()})`,
			);
		}
		if (result.stdout.trim() !== entry.versionOutput) {
			throw new Error(
				`pinned ${entry.providerId} reported ${JSON.stringify(result.stdout.trim())}, expected ` +
					`exactly ${JSON.stringify(entry.versionOutput)} — refusing a mismatched artifact`,
			);
		}
		invoked.push({
			providerId: entry.providerId,
			platformKey: resolution.platformKey,
			versionOutput: result.stdout.trim(),
		});
	}
	return { pinned, invoked };
}

if (import.meta.main) {
	try {
		const result = await smokeProviderTools();
		const tools = result.pinned.map((pin) => `${pin.tool}@${pin.pinnedVersion}`).join(", ");
		const hosts = result.invoked
			.map((run) => `${run.providerId} (${run.platformKey}): ${run.versionOutput}`)
			.join("; ");
		console.log(`smoke-provider-tools: pinned ${tools}; offline invocation verified — ${hosts}`);
	} catch (error) {
		console.error(
			`smoke-provider-tools: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
