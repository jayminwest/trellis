/**
 * The internal native-analyzer capability registry (SPEC §16, plan `pl-43c5`
 * step 3 — trellis-cb51).
 *
 * The registry makes trellis's existing native analyzers addressable through
 * **explicit supported ids and dependency declarations**: every registration
 * pairs a validated native provider identity (`trellis.complexity`, …, the
 * §16.2 contract) with the capabilities it provides, the contract metric ids
 * it emits, and the prerequisite analyzer ids it consumes. `buildNativeRegistry`
 * validates the declaration set up front and rejects, with deterministic
 * errors (AC4):
 *
 * - **duplicate analyzer ids** — one id, one analyzer;
 * - **duplicate capability ownership** and **duplicate metric ownership** —
 *   a capability or metric id has exactly one owning analyzer, so a later
 *   dispatcher can never dispatch ambiguously (the same invariant the
 *   versioned `capabilityDeclarationsSchema` enforces for providers);
 * - **missing prerequisites** — a dependency on an unregistered id;
 * - **dependency cycles** — reported as a canonical, rotation-normalized
 *   `a -> b -> a` path.
 *
 * The registry performs **no arbitrary module loading**: registrations are
 * explicit typed objects in trellis source, never id→module-path maps or
 * dynamic imports (§16.4 — the controlled process runner is the only seam
 * that may start anything).
 *
 * Scoring separation (AC3, §16.5): {@link requiredForScoring} derives the
 * analyzers the **current scoring catalog** (`SCORING_FORMULA` term ids)
 * requires — the owners of catalog metric ids plus their transitive
 * prerequisites. The non-scoring safeguard inspection declares no metrics,
 * so it can never be derived into the scored set.
 */
import { type ProviderIdentity, providerIdentitySchema } from "../contract/index.ts";
import { SCORING_FORMULA } from "../scoring/index.ts";

/** One native analyzer's registration: identity plus what it owns and needs. */
export interface NativeAnalyzerRegistration {
	/** The analyzer's provider identity — `kind: "native"`, id under `trellis.*` (§16.2). */
	identity: ProviderIdentity;
	/** Capability ids this analyzer provides; each id has exactly one owner. */
	capabilities: readonly string[];
	/** Contract metric ids this analyzer emits; each id has exactly one owner. */
	metrics: readonly string[];
	/** Prerequisite analyzer ids this analyzer consumes (e.g. cycles → graph). */
	requires: readonly string[];
}

/** A validated registration inside a {@link NativeRegistry}. */
export type NativeAnalyzer = NativeAnalyzerRegistration;

/** A validated set of native analyzers addressable by supported id. */
export interface NativeRegistry {
	/** Every registered analyzer, sorted by id. */
	readonly analyzers: readonly NativeAnalyzer[];
	/** Look up one analyzer by its supported id; `undefined` when unregistered. */
	get(id: string): NativeAnalyzer | undefined;
	/** Whether `id` names a registered analyzer. */
	has(id: string): boolean;
	/**
	 * Deterministic topological order: prerequisites first, ties broken by id
	 * ascending — the order a consumer may run the analyzers in.
	 */
	ordered(): readonly NativeAnalyzer[];
}

/** Validate one registration's identity against the versioned contract (deterministic message). */
function requireValidIdentity(registration: NativeAnalyzerRegistration): void {
	const parsed = providerIdentitySchema.safeParse(registration.identity);
	if (parsed.success) return;
	const issue = parsed.error.issues[0];
	const path = issue === undefined ? "" : `${issue.path.join(".")}: `;
	const message = issue === undefined ? "invalid provider identity" : issue.message;
	throw new Error(
		`native analyzer identity "${registration.identity.id}" is invalid: ${path}${message}`,
	);
}

/** Reject duplicate analyzer ids (AC4). */
function requireUniqueIds(registrations: readonly NativeAnalyzerRegistration[]): void {
	const seen = new Set<string>();
	for (const registration of registrations) {
		const id = registration.identity.id;
		if (seen.has(id)) {
			throw new Error(`analyzer "${id}" is registered more than once`);
		}
		seen.add(id);
	}
}

/** Reject a capability or metric id owned by two analyzers (AC4 — no ambiguous dispatch). */
function requireSoleOwnership(
	registrations: readonly NativeAnalyzerRegistration[],
	field: "capabilities" | "metrics",
	label: string,
): void {
	const owners = new Map<string, string>();
	for (const registration of registrations) {
		for (const id of registration[field]) {
			const previous = owners.get(id);
			if (previous !== undefined) {
				throw new Error(`${label} "${id}" is declared by both "${previous}" and "${registration.identity.id}"`);
			}
			owners.set(id, registration.identity.id);
		}
	}
}

/** Reject prerequisites that name no registered analyzer (AC4). */
function requireRegisteredPrerequisites(
	byId: ReadonlyMap<string, NativeAnalyzerRegistration>,
): void {
	for (const [id, registration] of byId) {
		for (const prerequisite of registration.requires) {
			if (!byId.has(prerequisite)) {
				throw new Error(`analyzer "${id}" requires unregistered analyzer "${prerequisite}"`);
			}
		}
	}
}

/**
 * Reject dependency cycles (AC4), reported as a canonical path rotated to its
 * lexicographically smallest member so the same cycle always yields the same
 * message regardless of registration order.
 */
function requireAcyclic(byId: ReadonlyMap<string, NativeAnalyzerRegistration>): void {
	const visiting = new Set<string>();
	const stack: string[] = [];
	const walk = (id: string): void => {
		if (visiting.has(id)) {
			const start = stack.lastIndexOf(id);
			const loop = stack.slice(start === -1 ? 0 : start);
			const smallest = loop.indexOf([...loop].sort()[0] ?? id);
			const rotated = [...loop.slice(smallest), ...loop.slice(0, smallest)];
			const canonical = [...rotated, rotated[0] ?? id];
 *			throw new Error(`analyzer dependency cycle: ${canonical.map((x) => `"${x}"`).join(" -> ")}`);
 *		}
		if (!byId.has(id)) return;
		visiting.add(id);
		stack.push(id);
		for (const prerequisite of byId.get(id)?.requires ?? []) walk(prerequisite);
		stack.pop();
		visiting.delete(id);
	};
	for (const id of [...byId.keys()].sort()) walk(id);
}

/**
 * Validate a registration set and return the registry (throws the
 * deterministic AC4 errors above; see the module docblock). Registrations are
 * typed declarations — no module loading, no dynamic dispatch.
 */
export function buildNativeRegistry(
	registrations: readonly NativeAnalyzerRegistration[],
): NativeRegistry {
	for (const registration of registrations) requireValidIdentity(registration);
	requireUniqueIds(registrations);
	requireSoleOwnership(registrations, "capabilities", "capability");
	requireSoleOwnership(registrations, "metrics", "metric");
	const byId = new Map(registrations.map((registration) => [registration.identity.id, registration]));
	requireRegisteredPrerequisites(byId);
	requireAcyclic(byId);
	const analyzers = [...byId.values()].sort((a, b) =>
		a.identity.id < b.identity.id ? -1 : a.identity.id > b.identity.id ? 1 : 0,
	);
	const registry: NativeRegistry = {
		analyzers,
		get: (id) => byId.get(id),
		has: (id) => byId.has(id),
		ordered: () => topologicalOrder(analyzers),
	};
	return registry;
}

/** Kahn's algorithm over the already-sorted analyzer list; prerequisites first. */
function topologicalOrder(analyzers: readonly NativeAnalyzer[]): readonly NativeAnalyzer[] {
	const remaining = new Map(analyzers.map((analyzer) => [analyzer.identity.id, analyzer]));
	const ordered: NativeAnalyzer[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()]
			.filter((analyzer) => analyzer.requires.every((id) => !remaining.has(id)))
			.sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
		const next = ready[0];
		if (next === undefined) {
			// Unreachable: buildNativeRegistry rejects cycles before ordering.
			throw new Error("analyzer dependency cycle detected while ordering the registry");
		}
		remaining.delete(next.identity.id);
		ordered.push(next);
	}
	return ordered;
}

/** The contract metric ids the current scoring catalog consumes (SCORING_FORMULA terms). */
export function scoringCatalogMetricIds(): string[] {
	return [
		...new Set(
			SCORING_FORMULA.dimensions.flatMap((dimension) =>
				dimension.terms.map((term) => term.metricId),
			),
		),
	].sort();
}

/**
 * The analyzers the scoring catalog requires (AC3): every owner of a catalog
 * metric id plus its transitive prerequisites — without the graph there are
 * no import-cycle metrics, so prerequisites are required by construction.
 * Analyzers that emit no catalog metrics (the safeguard inspection) are
 * never included.
 */
export function requiredForScoring(
	registry: NativeRegistry,
	catalog: readonly string[] = scoringCatalogMetricIds(),
): string[] {
	const byMetric = new Map<string, string>();
	for (const analyzer of registry.analyzers) {
		for (const metric of analyzer.metrics) byMetric.set(metric, analyzer.identity.id);
	}
	const required = new Set<string>();
	const addTransitively = (id: string): void => {
		if (required.has(id)) return;
		required.add(id);
		for (const prerequisite of registry.get(id)?.requires ?? []) addTransitively(prerequisite);
	};
	for (const metric of catalog) {
		const owner = byMetric.get(metric);
		if (owner !== undefined) addTransitively(owner);
	}
	return [...required].sort();
}
