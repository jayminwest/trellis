/**
 * The dependency-cruiser adapter entry point (SPEC §16.2–16.4, plan
 * `pl-43c5` step 22 — trellis-adbf): execute the pinned tool over a
 * **staged source view** (trellis-2fe6's `../workspace.ts`) in the single
 * declared-rules mode, and turn its raw JSON into **validated typed
 * evidence** before any normalization (`./normalize.ts` owns that; the
 * adapter never scores, aggregates or invents).
 *
 * `runDependencyCruiserAdapter` composes the delivered boundaries: the
 * pinned artifact is resolved and verified through the manifest/resolver
 * (`../manifest.ts` + `../resolve.ts`), the **pure-JavaScript launcher**
 * runs under trellis's own runtime through the controlled process runner
 * (`../process.ts` — the pinned launcher path crosses as an inert first
 * argument, never a PATH lookup or target command), its `--version`
 * output is checked against the pin before anything runs, and the
 * TypeScript compiler the tool will actually load is resolved and
 * recorded (`./invocation.ts`) — a missing or mismatched parser produced
 * a successful empty graph in the research record, so the adapter refuses
 * to run blind. The cruise itself (`./cruise-run.ts`) evaluates the
 * compiled declarative policy through a trellis-generated config in
 * owned scratch — never a target `.dependency-cruiser` file.
 *
 * State mapping (§16.2, honest per run):
 *
 * | outcome | when |
 * | --- | --- |
 * | `complete` | report validated, and the reported graph asserts **every** staged file with no staging gaps |
 * | `incomplete` | the tool ran but its evidence is malformed, suspect, or cannot assert full coverage — with located reasons; schema-valid raw evidence is still attached |
 * | `unavailable` | could not run: unresolvable/unverified pin, missing TypeScript parser, failed version check, exhausted execution limits, unusable scratch |
 * | `unsupported` | the host platform has no pinned platform record |
 *
 * Requests are validated before anything runs — an invalid request is an
 * operational error (SPEC §16.3); every run failure is located evidence,
 * never rethrown.
 */
import type { DependencyCruiserProviderRequest } from "../../contract/index.ts";
import { pinnedTool } from "../manifest.ts";
import { runControlledProcess } from "../process.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import { type DependencyCruiserOutcome, runDependencyCruiserCruise } from "./cruise-run.ts";
import {
	type DependencyCruiserRequest,
	dependencyCruiserEnvironment,
	dependencyCruiserProviderIdentity,
	normalizeDependencyCruiserRequest,
	pinnedLauncherInvocation,
	resolveDependencyCruiserTypescript,
} from "./invocation.ts";
import { compileArchitecturePolicy } from "./policy.ts";
import {
	DEPENDENCY_CRUISER_ADAPTER_VERSION,
	DEPENDENCY_CRUISER_PARSER_ENGINE,
	DEPENDENCY_CRUISER_PROVIDER_ID,
} from "./raw.ts";

/** The adapter result: resolution and parser provenance plus the one cruise outcome. */
export interface DependencyCruiserAdapterResult {
	/** The pinned tool version (manifest identity — never what a binary happened to report). */
	toolVersion: string;
	/** This adapter's version (provider identity, SPEC §16.2). */
	adapterVersion: string;
	/** How the pinned artifact resolved on this host. */
	resolution:
		| { state: "available"; platformKey: string; binaryDigestVerified: boolean }
		| { state: "unavailable" | "unsupported"; reason: string; instructions: string };
	/**
	 * The TypeScript compiler the tool resolves locally (parser identity,
	 * §16.2): its recorded version, or the located reason it could not be
	 * resolved — never an assumption that the tool's parser matches
	 * trellis's own.
	 */
	parser: { engine: string; version: string } | { state: "unavailable"; reason: string };
	/** The single declared-rules cruise outcome. */
	outcome: DependencyCruiserOutcome;
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
		env: dependencyCruiserEnvironment(homeDir),
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
			reason: `pinned dependency-cruiser version check could not run (${reason})`,
		};
	}
	const reported = result.stdout.trim();
	if (result.outcome.exitCode !== 0 || reported !== expected) {
		return {
			ok: false,
			reason:
				`the resolved dependency-cruiser is not the pinned tool: --version reported ${JSON.stringify(reported)}, ` +
				`expected ${JSON.stringify(expected)}`,
		};
	}
	return { ok: true };
}

/** The unavailable cruise outcome for a run that never started, with the policy's own identity. */
function unavailableOutcome(
	request: DependencyCruiserProviderRequest,
	reason: string,
	instructions?: string,
): DependencyCruiserOutcome {
	return {
		state: "unavailable",
		provider: dependencyCruiserProviderIdentity(compileArchitecturePolicy(request)),
		reason,
		...(instructions === undefined ? {} : { instructions }),
	};
}

/**
 * Run the pinned dependency-cruiser adapter over a staged view: compile the
 * declarative request into the normalized policy, resolve and verify the
 * pinned artifact, resolve and record the tool's TypeScript parser, check
 * the version, then run the one cruise (see the module docblock). Invalid
 * requests are operational errors (SPEC §16.3); run failures are located
 * evidence, never rethrown.
 */
export async function runDependencyCruiserAdapter(
	view: StagedWorkspaceView,
	request: DependencyCruiserProviderRequest,
	options: DependencyCruiserRequest = {},
): Promise<DependencyCruiserAdapterResult> {
	const normalized = normalizeDependencyCruiserRequest(options);
	const policy = compileArchitecturePolicy(request);
	const entry = pinnedTool(DEPENDENCY_CRUISER_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${DEPENDENCY_CRUISER_PROVIDER_ID}"`);
	}
	const base = {
		toolVersion: entry.pinnedVersion,
		adapterVersion: DEPENDENCY_CRUISER_ADAPTER_VERSION,
	};
	const neverRanParser = { engine: "unresolved", version: "0.0.0" };

	const resolution = resolvePinnedTool(DEPENDENCY_CRUISER_PROVIDER_ID, normalized.resolve);
	if (resolution.state !== "available") {
		return {
			...base,
			resolution: {
				state: resolution.state,
				reason: resolution.reason,
				instructions: resolution.instructions,
			},
			parser: neverRanParser,
			outcome: unavailableOutcome(request, resolution.reason, resolution.instructions),
		};
	}
	const availableResolution = {
		state: "available" as const,
		platformKey: resolution.platformKey,
		binaryDigestVerified: resolution.binaryDigestVerified,
	};

	const parser = resolveDependencyCruiserTypescript(resolution);
	if (!("version" in parser)) {
		return {
			...base,
			resolution: availableResolution,
			parser: { state: "unavailable", reason: parser.reason },
			outcome: unavailableOutcome(request, parser.reason),
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
			parser: { engine: DEPENDENCY_CRUISER_PARSER_ENGINE, version: parser.version },
			outcome: unavailableOutcome(request, version.reason),
		};
	}

	const outcome = await runDependencyCruiserCruise(
		view,
		policy,
		invocation,
		parser.version,
		limits,
	);
	return {
		...base,
		resolution: availableResolution,
		parser: { engine: DEPENDENCY_CRUISER_PARSER_ENGINE, version: parser.version },
		outcome,
	};
}
