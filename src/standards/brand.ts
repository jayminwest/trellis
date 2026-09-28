/**
 * os-eco CLI brand check (docs/brand-standard.md). A small, static, offline
 * read of the parts of the brand standard that are cheap to verify from files:
 *
 *   - `bin-pair`      — package.json `bin` carries the long name (the package
 *                       name without scope and `-cli`) plus a short alias.
 *   - `description`   — package.json `description` is one plain line, no emoji.
 *   - `readme-badges` — README.md carries the npm, CI, and license badges.
 *   - `commands`      — src/ registers `prime`, `onboard`, and `setup` commands
 *                       (commander `.command("<name>")` calls).
 *
 * Every miss is a {@link BrandFinding}. Like drift, this is a separate
 * capability: it never feeds the sloppiness index and never throws on a
 * nonconforming repo — a missing file is itself a finding.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** The brand rules this check verifies, in report order. */
export const BRAND_RULES = ["bin-pair", "description", "readme-badges", "commands"] as const;
export type BrandRule = (typeof BRAND_RULES)[number];

/** One unmet brand rule. */
export interface BrandFinding {
	rule: BrandRule;
	detail: string;
}

/** Whole-repo brand result. An empty `findings` list means the repo conforms. */
export interface BrandReport {
	/** Repo id — basename of the checked path. */
	repo: string;
	/** Rules evaluated, in order. */
	rules: BrandRule[];
	findings: BrandFinding[];
}

/** Commands every os-eco CLI registers (`setup` hosts `setup claude`). */
const BRAND_COMMANDS = ["prime", "onboard", "setup"] as const;

/** README badge markers: npm version, CI workflow, license. */
const BADGES: ReadonlyArray<[name: string, pattern: RegExp]> = [
	["npm", /img\.shields\.io\/npm\/v\//],
	["CI", /actions\/workflows\/[^)\s]+\/badge\.svg/],
	["license", /img\.shields\.io\/badge\/license/i],
];

const EMOJI = /\p{Extended_Pictographic}/u;

/** Read and parse `package.json`, or `undefined` when absent/invalid. */
function readPackage(root: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** `@os-eco/seeds-cli` → `seeds`. */
function longBinName(packageName: string): string {
	return packageName.replace(/^@[^/]+\//, "").replace(/-cli$/, "");
}

function checkBinPair(pkg: Record<string, unknown>): string | undefined {
	const name = typeof pkg.name === "string" ? pkg.name : "";
	const long = longBinName(name);
	const bin = pkg.bin;
	const bins = bin && typeof bin === "object" ? Object.keys(bin) : [];
	if (!bins.includes(long))
		return `bin lacks the long name "${long}" (has: ${bins.join(", ") || "none"})`;
	if (bins.length < 2) return `bin "${long}" has no short alias`;
	return undefined;
}

function checkDescription(pkg: Record<string, unknown>): string | undefined {
	const description = typeof pkg.description === "string" ? pkg.description.trim() : "";
	if (!description) return "package.json has no description";
	if (description.includes("\n")) return "description spans more than one line";
	if (EMOJI.test(description)) return `description contains emoji: "${description}"`;
	return undefined;
}

function checkBadges(root: string): string | undefined {
	const path = join(root, "README.md");
	if (!existsSync(path)) return "README.md is missing";
	const readme = readFileSync(path, "utf8");
	const missing = BADGES.filter(([, pattern]) => !pattern.test(readme)).map(([name]) => name);
	return missing.length ? `README.md lacks badges: ${missing.join(", ")}` : undefined;
}

/** All `.ts` sources under `dir`, skipping tests and node_modules. */
function sources(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") out.push(...sources(path));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(path);
		}
	}
	return out;
}

function checkCommands(root: string): string | undefined {
	const text = sources(join(root, "src"))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
	const missing = BRAND_COMMANDS.filter(
		(name) => !new RegExp(`\\.command\\(\\s*["'\`]${name}\\b`).test(text),
	);
	return missing.length ? `src/ registers no command: ${missing.join(", ")}` : undefined;
}

/** Check one repo against the static parts of the os-eco brand standard. */
export function checkBrand(repoPath: string): BrandReport {
	const pkg = readPackage(repoPath);
	const results: Array<[BrandRule, string | undefined]> = pkg
		? [
				["bin-pair", checkBinPair(pkg)],
				["description", checkDescription(pkg)],
			]
		: [
				["bin-pair", "package.json is missing or invalid"],
				["description", "package.json is missing or invalid"],
			];
	results.push(["readme-badges", checkBadges(repoPath)], ["commands", checkCommands(repoPath)]);
	const findings: BrandFinding[] = [];
	for (const [rule, detail] of results) if (detail) findings.push({ rule, detail });
	return { repo: basename(resolve(repoPath)), rules: [...BRAND_RULES], findings };
}
