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
 *   `structurally-wired`. For the JSON budgets the evidence may take **one
 *   hop**: a CI-reachable script body or CI command runs a repo-local file
 *   (e.g. `bun run scripts/check-file-sizes.ts`) whose text names the budget
 *   path — or its basename when the file sits beside the budget. The file is
 *   read as text only, never imported or executed, and the note records the
 *   chain script → file → budget (trellis-b412);
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
	/** Follow one hop into repo-local files a CI-reachable command runs (trellis-b412). */
	followScriptFiles: boolean;
}

const BUDGET_SPECS: Record<string, BudgetSpec> = {
	"coverage-budget": {
		files: ["scripts/coverage-budgets.json", "coverage-budgets.json"],
		enforcedBy: (body, budgetPath) => body.includes(budgetPath),
		followScriptFiles: true,
	},
	"file-size-budget": {
		files: ["scripts/file-size-budgets.json", "file-size-budgets.json"],
		enforcedBy: (body, budgetPath) => body.includes(budgetPath),
		followScriptFiles: true,
	},
	"duplication-budget": {
		files: [".jscpd.json"],
		enforcedBy: (body) => /\bjscpd\b/.test(body),
		followScriptFiles: false,
	},
};

/** Executable configs that may hold coverage thresholds — unsupported surfaces. */
const EXECUTABLE_COVERAGE_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.js",
	"jest.config.ts",
	"jest.config.js",
];

/** The directory part of a repo-relative POSIX path (`""` at the root). */
function dirOf(rel: string): string {
	const slash = rel.lastIndexOf("/");
	return slash === -1 ? "" : rel.slice(0, slash);
}

/** True when a script file's text names the budget (full path, or basename beside it). */
function fileNamesBudget(filePath: string, text: string, budgetPath: string): boolean {
	if (text.includes(budgetPath)) return true;
	const basename = budgetPath.slice(budgetPath.lastIndexOf("/") + 1);
	return dirOf(filePath) === dirOf(budgetPath) && text.includes(basename);
}

/** CI-reachable command bodies with a label naming where each is reached from. */
function ciReachableBodies(ctx: SafeguardContext): { label: string; body: string }[] {
	const bodies = ctx.workflows.flatMap((w) =>
		w.commands.map((c) => ({ label: `${w.path} runs`, body: c.text })),
	);
	const reach = ciReachableScripts(ctx);
	for (const script of ctx.manifest?.scripts ?? []) {
		const via = reach.get(script.name);
		if (via !== undefined) {
			bodies.push({
				label: `script '${script.name}' (reachable from ${via.workflow}) runs`,
				body: script.body,
			});
		}
	}
	return bodies;
}

/** One hop: a CI-reachable command runs a local file whose text names the budget. */
async function budgetEnforcedViaFile(
	ctx: SafeguardContext,
	budgetPath: string,
): Promise<string | null> {
	for (const { label, body } of ciReachableBodies(ctx)) {
		for (const filePath of extractLocalPaths(body)) {
			if (filePath === budgetPath) continue;
			const text = await ctx.readText(filePath);
			if (text !== null && fileNamesBudget(filePath, text, budgetPath)) {
				return `${label} ${filePath}, which names ${budgetPath}`;
			}
		}
	}
	return null;
}

/** True when `body` runs the check directly or via a `run` reference chain. */
async function budgetEnforced(
	ctx: SafeguardContext,
	spec: BudgetSpec,
	budgetPath: string,
): Promise<string | null> {
	const scripts = ctx.manifest?.scripts ?? [];
	const ciDirect = ctx.workflows.some((w) =>
		w.commands.some((c) => spec.enforcedBy(c.text, budgetPath)),
	);
	if (ciDirect) return "a CI workflow invokes the enforcing check";
	// ciReachableScripts computes the full run-reference closure, so a hit here
	// covers direct and transitive wiring alike.
	const reach = ciReachableScripts(ctx);
	for (const script of scripts) {
		const via = reach.get(script.name);
		if (via !== undefined && spec.enforcedBy(script.body, budgetPath)) {
			return `script '${script.name}' is reachable from ${via.workflow}`;
		}
	}
	return spec.followScriptFiles ? budgetEnforcedViaFile(ctx, budgetPath) : null;
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
