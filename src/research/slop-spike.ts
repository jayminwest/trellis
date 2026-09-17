/** Research protocol v1: three uncalibrated signals, never a sloppiness score. */
import { loadAuditConfig } from "../config/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory, type SyntaxInventory } from "../syntax/index.ts";
import { type Dispatch, dispatchesIn, type Forwarder, forwarderAt } from "./slop-signals.ts";

function dispatchFamilies(dispatches: Dispatch[]) {
	const groups = new Map<string, Dispatch[]>();
	for (const site of dispatches) {
		const key = JSON.stringify(site.cases);
		const group = groups.get(key) ?? [];
		group.push(site);
		groups.set(key, group);
	}
	return [...groups.values()]
		.filter((sites) => sites.length > 1)
		.map((sites) => ({
			cases: sites[0]?.cases ?? [],
			siteCount: sites.length,
			fileCount: new Set(sites.map((site) => site.path)).size,
			sites,
		}));
}

function disagreement(left: Dispatch, right: Dispatch) {
	const shared = left.cases.filter((value) => right.cases.includes(value));
	const unionSize = new Set([...left.cases, ...right.cases]).size;
	// Exploratory threshold, not a calibrated probability or semantic equivalence claim.
	if (shared.length < 2 || shared.length === unionSize || shared.length / unionSize < 2 / 3)
		return undefined;
	return {
		left,
		right,
		shared,
		onlyLeft: left.cases.filter((value) => !right.cases.includes(value)),
		onlyRight: right.cases.filter((value) => !left.cases.includes(value)),
	};
}

function dispatchDisagreements(dispatches: Dispatch[]) {
	const result = [];
	for (const [i, left] of dispatches.entries()) {
		for (const right of dispatches.slice(i + 1)) {
			const pair = disagreement(left, right);
			if (pair) result.push(pair);
		}
	}
	return result;
}

/** Production scope only; malformed files are omitted explicitly, never counted as clean. */
export function measureSlopHypotheses(inventory: SyntaxInventory) {
	const production = inventory.files
		.filter((file) => file.sourceSet === "production")
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const files = production.filter((file) => file.diagnostics.length === 0);
	const forwarders: Forwarder[] = [];
	for (const file of files) {
		for (const fn of file.functions) {
			const site = forwarderAt(file, fn);
			if (site) forwarders.push(site);
		}
	}
	const dispatches = files.flatMap(dispatchesIn);
	// Explicit bound on the quadratic probe; partial output cannot masquerade as absence.
	const canCompare = dispatches.length <= 1000;
	return {
		protocol: "slop-hypotheses-v1",
		status: "experimental-evidence-only",
		compilerVersion: inventory.compilerVersion,
		completeness: inventory.completeness,
		scope: {
			sourceSet: "production",
			files: files.length,
			functions: files.reduce((sum, file) => sum + file.functions.length, 0),
			skipped: production.filter((file) => file.diagnostics.length > 0).map((file) => file.path),
			diagnostics: inventory.diagnostics,
		},
		forwarders,
		dispatches,
		dispatchFamilies: dispatchFamilies(dispatches),
		dispatchDisagreements: {
			state: canCompare ? "complete" : "incomplete",
			reason: canCompare ? null : "More than 1000 eligible switches; pair comparison skipped",
			pairs: canCompare ? dispatchDisagreements(dispatches) : [],
		},
	};
}

/** Separate opt-in research service; uses the existing configuration/discovery/parse core. */
export async function runSlopSpike(root: string) {
	const config = await loadAuditConfig(root);
	const source = await discoverSourceInventory(root, { source: config.source });
	const report = measureSlopHypotheses(await buildSyntaxInventory(source));
	return {
		...report,
		sourceConfig: config.source ?? {},
		excluded: source.excluded,
		unsupported: source.unsupported,
	};
}
