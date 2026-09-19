/** Internal research service. No public surface or scoring integration. */
import { createHash } from "node:crypto";
import pairs from "../../docs/research/maintainability-pairs.json";
import { loadAuditConfig } from "../config/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import { analyzeDuplication } from "../metrics/analyze-duplication.ts";
import {
	buildSyntaxInventory,
	collectFunctions,
	countLines,
	parseSource,
	type SyntaxInventory,
} from "../syntax/index.ts";
import { contextualizeClones } from "./maintainability-clones.ts";
import { measureFlow } from "./maintainability-flow.ts";

export function measureMaintainability(inventory: SyntaxInventory) {
	const files = inventory.files
		.filter((file) => file.sourceSet === "production")
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const functions = files
		.filter((file) => file.diagnostics.length === 0)
		.flatMap((file) =>
			file.functions.map((fn) => ({
				path: file.path,
				name: fn.name,
				range: fn.range,
				...measureFlow(fn),
			})),
		);
	const duplication = analyzeDuplication({ ...inventory, files });
	const clones = contextualizeClones(duplication.scopes.production.groups, files);
	const duplicationMetrics = duplication.metrics.filter((metric) =>
		metric.id.endsWith(".production"),
	);
	const duplicationComplete = duplicationMetrics.every((metric) => metric.state !== "incomplete");
	const hash = createHash("sha256");
	for (const file of files) hash.update(JSON.stringify([file.path, file.sourceFile.text]));
	return {
		protocol: "maintainability-v1",
		status: "experimental-evidence-only",
		compiler: inventory.compilerVersion,
		snapshot: hash.digest("hex"),
		completeness: inventory.completeness,
		diagnostics: inventory.diagnostics,
		skipped: files.filter((file) => file.diagnostics.length > 0).map((file) => file.path),
		summary: {
			files: files.length,
			functions: functions.length,
			eroded: functions.filter((fn) => fn.cc > 10).length,
			shallowEroded: functions.filter((fn) => fn.cc > 10 && fn.maxNesting <= 1).length,
			cloneGroups: duplicationComplete ? clones.length : null,
			overlappingGroups: duplicationComplete
				? clones.filter((group) => group.lineOverlap).length
				: null,
			registrationGroups: duplicationComplete
				? clones.filter((group) =>
						group.members.some((member) => member.context === "registration-candidate"),
					).length
				: null,
		},
		functions,
		duplication: {
			state: duplicationComplete ? "complete" : "incomplete",
			metrics: duplicationMetrics,
			exhaustion: duplication.scopes.production.exhaustion,
			clones,
		},
	};
}

export async function runMaintainabilitySpike(root: string) {
	const config = await loadAuditConfig(root);
	const source = await discoverSourceInventory(root, { source: config.source });
	return {
		...measureMaintainability(await buildSyntaxInventory(source)),
		sourceConfig: config.source ?? {},
		excluded: source.excluded,
		unsupported: source.unsupported,
	};
}

/** Compact research artifact; all clone evidence, top 20 functions per ranking. */
export function summarizeMaintainability(report: ReturnType<typeof measureMaintainability>) {
	const { functions, ...rest } = report;
	const top = (key: "cc" | "flow") => [...functions].sort((a, b) => b[key] - a[key]).slice(0, 20);
	return {
		...rest,
		rankings: { byCc: top("cc"), byFlow: top("flow") },
		ccHistogram: functions.reduce<Record<number, number>>((counts, fn) => {
			counts[fn.cc] = (counts[fn.cc] ?? 0) + 1;
			return counts;
		}, {}),
	};
}

/** Parse committed paired examples; this command never executes their source. */
export function measureMaintainabilityPairs() {
	const measure = (source: string) => {
		const parsed = parseSource("pair.ts", source);
		const facts = collectFunctions(parsed.sourceFile);
		const report = measureMaintainability({
			root: "/pair",
			compilerVersion: "fixture",
			functionCount: facts.functions.length,
			completeness: parsed.diagnostics.length ? "incomplete" : "complete",
			diagnostics: parsed.diagnostics,
			files: [
				{
					...parsed,
					...facts,
					path: "pair.ts",
					packagePath: ".",
					sourceSet: "production",
					lines: countLines(parsed.sourceFile),
				},
			],
		});
		return {
			...report.summary,
			maxCc: Math.max(...report.functions.map((fn) => fn.cc)),
			maxFlow: Math.max(...report.functions.map((fn) => fn.flow)),
			totalFlow: report.functions.reduce((sum, fn) => sum + fn.flow, 0),
			calls: report.functions.reduce((sum, fn) => sum + fn.calls, 0),
		};
	};
	return pairs.map((pair) => ({
		id: pair.id,
		prediction: pair.prediction,
		before: measure(pair.before),
		after: measure(pair.after),
	}));
}
