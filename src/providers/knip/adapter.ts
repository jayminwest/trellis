/**
 * The Knip adapter entry point (SPEC §16.2–16.4, plan `pl-43c5` step 24 —
 * trellis-8ebc): execute the pinned tool over a **staged source view**
 * (trellis-2fe6's `../workspace.ts`) in the one declared contextual mode,
 * and turn its raw JSON into **validated typed evidence** before any
 * normalization (`./normalize.ts` owns that; the adapter never scores,
 * aggregates or invents).
 *
 * `runKnipAdapter` composes the delivered boundaries: the prepared
 * reachability context (step 23's `./context.ts` — compiled from the
 * declarative request over the measured selection, before staging, so its
 * roots and recorded assumptions describe the audit's selection, never the
 * staged subset) is the one input; the pinned artifact is resolved and
 * verified through the manifest/resolver (`../manifest.ts` +
 * `../resolve.ts`), the **pure-JavaScript Bun launcher** runs under
 * trellis's own runtime through the controlled process runner
 * (`../process.ts` — the pinned launcher path crosses as an inert first
 * argument, never a PATH lookup or target command), its `--version` output
 * is checked against the pin before anything runs, the `oxc-parser` the
 * tool will actually load is resolved and recorded (`./invocation.ts`), and
 * the runtime plugin registry is enumerated from the pinned artifact so
 * every plugin can be explicitly disabled (`./tool-config.ts`). The pass
 * itself (`./knip-run.ts`) evaluates the context through a
 * trellis-generated configuration in owned scratch — never a target `knip`
 * configuration, never plugin-driven execution.
 *
 * State mapping (§16.2, honest per run):
 *
 * | outcome | when |
 * | --- | --- |
 * | `complete` | report validated, every submitted scope pattern matched, no staging gaps |
 * | `incomplete` | the tool ran but its evidence is malformed, suspect, or cannot assert its scope — with located reasons; schema-valid raw evidence is still attached |
 * | `unavailable` | could not run: unresolvable/unverified pin, unresolvable parser or plugin registry, failed version check, exhausted execution limits, unusable scratch |
 * | `unsupported` | the host platform has no pinned platform record |
 *
 * Requests are validated before anything runs — an invalid request is an
 * operational error (SPEC §16.3); every run failure is located evidence,
 * never rethrown.
 */
import { dirname } from "node:path";
import { pinnedTool } from "../manifest.ts";
import { runControlledProcess } from "../process.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import type { PreparedReachabilityContext } from "./context.ts";
import {
	type KnipRequest,
	knipEnvironment,
	knipProviderIdentity,
	normalizeKnipRequest,
	pinnedLauncherInvocation,
	resolveKnipParser,
} from "./invocation.ts";
import { type KnipOutcome, runKnipReachabilityPass } from "./knip-run.ts";
import { KNIP_ADAPTER_VERSION, KNIP_PARSER_ENGINE, KNIP_PROVIDER_ID } from "./raw.ts";
import { disabledPluginNames } from "./tool-config.ts";

/** The adapter result: resolution, parser and registry provenance plus the one pass outcome. */
export interface KnipAdapterResult {
	/** The pinned tool version (manifest identity — never what a binary happened to report). */
	toolVersion: string;
	/** This adapter's version (provider identity, SPEC §16.2). */
	adapterVersion: string;
	/** How the pinned artifact resolved on this host. */
	resolution:
		| { state: "available"; platformKey: string; binaryDigestVerified: boolean }
		| { state: "unavailable" | "unsupported"; reason: string; instructions: string };
	/**
	 * The `oxc-parser` the tool resolves locally (parser identity, §16.2):
	 * its recorded version, or the located reason it could not be resolved.
	 */
	parser: { engine: string; version: string } | { state: "unavailable"; reason: string };
	/** The registry plugin count the generated configuration disables, or its located failure. */
	disabledPlugins: number | { state: "unavailable"; reason: string };
	/** The one contextual reachability pass outcome. */
	outcome: KnipOutcome;
}

/** Verify the pinned launcher reports exactly the pinned version output. */
async function verifyPinnedVersion(
	invocation: ReturnType<typeof pinnedLauncherInvocation>,
	homeDir: string,
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
	expected: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const result = await runControlledProcess(invocation.interpreter, {
		args: [invocation.launcher.path, "--version"],
		env: knipEnvironment(homeDir),
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		signal: limits.signal,
	});
	if (result.outcome.kind !== "exited") {
		const reason =
			"reason" in result.outcome
				? result.outcome.reason
				: `the provider process ${result.outcome.kind}`;
		return {
			ok: false,
			reason: `pinned knip version check could not run (${reason})`,
		};
	}
	const reported = result.stdout.trim();
	if (result.outcome.exitCode !== 0 || reported !== expected) {
		return {
			ok: false,
			reason:
				`the resolved knip is not the pinned tool: --version reported ${JSON.stringify(reported)}, ` +
				`expected ${JSON.stringify(expected)}`,
		};
	}
	return { ok: true };
}

/** The unavailable pass outcome for a run that never started, with the context's own identity. */
function unavailableOutcome(
	context: PreparedReachabilityContext,
	reason: string,
	instructions?: string,
): KnipOutcome {
	return {
		state: "unavailable",
		provider: knipProviderIdentity(context),
		reason,
		...(instructions === undefined ? {} : { instructions }),
	};
}

/**
 * Run the pinned knip adapter over a staged view for one prepared
 * reachability context: resolve and verify the pinned artifact, resolve the
 * tool's parser, enumerate the plugin registry, check the version, then
 * run the one contextual pass (see the module docblock). Invalid requests
 * are operational errors (SPEC §16.3); run failures are located evidence,
 * never rethrown.
 */
export async function runKnipAdapter(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	options: KnipRequest = {},
): Promise<KnipAdapterResult> {
	const normalized = normalizeKnipRequest(options);
	const entry = pinnedTool(KNIP_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${KNIP_PROVIDER_ID}"`);
	}
	const base = {
		toolVersion: entry.pinnedVersion,
		adapterVersion: KNIP_ADAPTER_VERSION,
	};

	const resolution = resolvePinnedTool(KNIP_PROVIDER_ID, normalized.resolve);
	if (resolution.state !== "available") {
		return {
			...base,
			resolution: {
				state: resolution.state,
				reason: resolution.reason,
				instructions: resolution.instructions,
			},
			parser: { engine: "unresolved", version: "0.0.0" },
			disabledPlugins: { state: "unavailable", reason: resolution.reason },
			outcome: unavailableOutcome(context, resolution.reason, resolution.instructions),
		};
	}
	const availableResolution = {
		state: "available" as const,
		platformKey: resolution.platformKey,
		binaryDigestVerified: resolution.binaryDigestVerified,
	};

	const parser = resolveKnipParser(resolution);
	if (!("version" in parser)) {
		return {
			...base,
			resolution: availableResolution,
			parser: { state: "unavailable", reason: parser.reason },
			disabledPlugins: { state: "unavailable", reason: parser.reason },
			outcome: unavailableOutcome(context, parser.reason),
		};
	}
	const parserIdentity = { engine: KNIP_PARSER_ENGINE, version: parser.version };

	const packageRoot = dirname(dirname(resolution.executablePath));
	const plugins = disabledPluginNames(packageRoot);
	if ("state" in plugins) {
		return {
			...base,
			resolution: availableResolution,
			parser: parserIdentity,
			disabledPlugins: plugins,
			outcome: unavailableOutcome(context, plugins.reason),
		};
	}

	const invocation = pinnedLauncherInvocation(resolution);
	const limits = {
		timeoutMs: normalized.timeoutMs,
		maxOutputBytes: normalized.maxOutputBytes,
		...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
	};
	const version = await verifyPinnedVersion(invocation, view.workDir, limits, entry.versionOutput);
	if (!version.ok) {
		return {
			...base,
			resolution: availableResolution,
			parser: parserIdentity,
			disabledPlugins: plugins.names.length,
			outcome: unavailableOutcome(context, version.reason),
		};
	}

	const outcome = await runKnipReachabilityPass(
		view,
		context,
		invocation,
		plugins.names,
		parser.version,
		limits,
	);
	return {
		...base,
		resolution: availableResolution,
		parser: parserIdentity,
		disabledPlugins: plugins.names.length,
		outcome,
	};
}
