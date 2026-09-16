/**
 * Quality-budget inspection (SPEC §5.5, trellis-a97d): coverage, file-size,
 * and duplication budgets plus the checks that enforce them.
 *
 * Supported budget formats (declarative only):
 *
 * - **coverage** — a JSON budget file (`scripts/coverage-budgets.json` or
 *   `coverage-budgets.json`);
 * - **file-size** — a JSON budget file (`scripts/file-size-budgets.json` or
 *   `file-size-budgets.json`);
 * - **duplication** — a `.jscpd.json` config or a declarative `jscpd` key in
 *   the root manifest.
 *
 * Evidence rules:
 *
 * - a parseable budget surface exists → `configured`;
 * - additionally, an enforcing check reference exists — a manifest script or
 *   CI `run:` command naming the budget file (or invoking `jscpd`, which reads
 *   `.jscpd.json` by convention) — and that reference is CI-reachable →
 *   `structurally-wired`;
 * - an unparseable budget file, or coverage thresholds living only in an
 *   executable test-runner config (`vitest.config.ts`, `jest.config.js`), →
 *   `unknown`: executable configuration is never imported or guessed;
 * - script bodies referencing **missing** local files (check scripts, budget
 *   JSON) produce located broken-reference findings (shared pass over every
 *   manifest script).
 */
import type { Finding } from "../contract/index.ts";
import { extractLocalPaths } from "./shell.ts";
import type { SafeguardContext, SurfaceEvidence } from "./types.ts";
import { brokenPathFindings, ciReachableScripts } from "./wiring.ts";

/** One budget kind's file surfaces and how its enforcing check is recognized. */
interface BudgetSpec {
	/** Candidate budget files, checked in order. */
	files: readonly string[];
	/**
	 * True when a script/CI command body enforces the budget: it names the
	 * budget file, or (duplication only) invokes the tool that reads the
	 * config by convention.
	 */
	enforcedBy: (body: string, budgetPath: string) => boolean;
}

const BUDGET_SPECS: Record<string, BudgetSpec> = {
	"coverage-budget": {
		files: ["scripts/coverage-budgets.json", "coverage-budgets.json"],
		enforcedBy: (body, budgetPath) => body.includes(budgetPath),
	},
	"file-size-budget": {
		files: ["scripts/file-size-budgets.json", "file-size-budgets.json"],
		enforcedBy: (body, budgetPath) => body.includes(budgetPath),
	},
	"duplication-budget": {
		files: [".jscpd.json"],
		enforcedBy: (body) => /\bjscpd\b/.test(body),
	},
};

/** Executable configs that may hold coverage thresholds — unsupported surfaces. */
const EXECUTABLE_COVERAGE_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.js",
	"jest.config.ts",
	"jest.config.js",
];

/** True when `body` runs the check directly or via a `run` reference chain. */
async function budgetEnforced(
	ctx: SafeguardContext,
	spec: BudgetSpec,
	budgetPath: string,
): Promise<string | null> {
	const scripts = ctx.manifest?.scripts ?? [];
	const direct = scripts.find((s) => spec.enforcedBy(s.body, budgetPath));
	const ciDirect = ctx.workflows.some((w) =>
		w.commands.some((c) => spec.enforcedBy(c.text, budgetPath)),
	);
	if (ciDirect) return "a CI workflow invokes the enforcing check";
	if (direct === undefined) return null;
	// ciReachableScripts computes the full run-reference closure, so a hit here
	// covers direct and transitive wiring alike.
	const via = ciReachableScripts(ctx).get(direct.name);
	if (via !== undefined) return `script '${direct.name}' is reachable from ${via.workflow}`;
	return null;
}

/** Inspect one budget kind. */
async function inspectBudget(ctx: SafeguardContext, spec: BudgetSpec): Promise<SurfaceEvidence> {
	for (const rel of spec.files) {
		const text = await ctx.readText(rel);
		if (text === null) continue;
		try {
			JSON.parse(text);
		} catch {
			return {
				level: "unknown",
				locations: [{ path: rel }],
				notes: [`${rel} is not parseable JSON; the budget is unverified`],
				findings: [],
			};
		}
		const enforced = await budgetEnforced(ctx, spec, rel);
		return {
			level: enforced !== null ? "structurally-wired" : "configured",
			locations: [{ path: rel }],
			notes: [
				enforced !== null
					? `enforcing check referenced: ${enforced}`
					: "no CI-reachable check references the budget",
			],
			findings: [],
		};
	}
	return { level: "absent", locations: [], notes: [], findings: [] };
}

/** The declarative `jscpd` manifest key is a budget surface too. */
async function inspectDuplication(ctx: SafeguardContext): Promise<SurfaceEvidence> {
	const file = await inspectBudget(ctx, BUDGET_SPECS["duplication-budget"] as BudgetSpec);
	if (file.level !== "absent") return file;
	if (ctx.manifest?.jscpdConfig === true) {
		const enforced = await budgetEnforced(
			ctx,
			BUDGET_SPECS["duplication-budget"] as BudgetSpec,
			"package.json",
		);
		return {
			level: enforced !== null ? "structurally-wired" : "configured",
			locations: [{ path: "package.json" }],
			notes: [
				enforced !== null
					? `enforcing check referenced: ${enforced}`
					: "no CI-reachable check invokes jscpd",
			],
			findings: [],
		};
	}
	return file;
}

/** Executable coverage configs downgrade an absent JSON surface to `unknown`. */
async function inspectCoverage(ctx: SafeguardContext): Promise<SurfaceEvidence> {
	const json = await inspectBudget(ctx, BUDGET_SPECS["coverage-budget"] as BudgetSpec);
	if (json.level !== "absent") return json;
	for (const rel of EXECUTABLE_COVERAGE_CONFIGS) {
		if (await ctx.fileExists(rel)) {
			return {
				level: "unknown",
				locations: [{ path: rel }],
				notes: [`${rel} is executable configuration; any coverage thresholds in it are unverified`],
				findings: [],
			};
		}
	}
	return json;
}

/**
 * Shared broken-reference pass over every manifest script: a script body
 * naming a repo-local file that does not exist is a broken check reference,
 * located at the script's package.json line.
 */
export async function findBrokenScriptReferences(ctx: SafeguardContext): Promise<Finding[]> {
	const findings: Finding[] = [];
	for (const script of ctx.manifest?.scripts ?? []) {
		const localPaths = extractLocalPaths(script.body);
		findings.push(
			...(await brokenPathFindings(
				ctx,
				{ path: ctx.manifest?.path ?? "package.json", line: script.line },
				script.body,
				`script '${script.name}'`,
				localPaths,
			)),
		);
	}
	return findings;
}

/** Inspect all budget kinds; ids map to their evidence. */
export async function inspectBudgets(ctx: SafeguardContext): Promise<Map<string, SurfaceEvidence>> {
	const results = new Map<string, SurfaceEvidence>();
	results.set("coverage-budget", await inspectCoverage(ctx));
	results.set(
		"file-size-budget",
		await inspectBudget(ctx, BUDGET_SPECS["file-size-budget"] as BudgetSpec),
	);
	results.set("duplication-budget", await inspectDuplication(ctx));
	return results;
}
