/**
 * Render fixtures for the §6.4 metric report (SPEC §12, trellis-a059).
 *
 * Each fixture is a real temporary repository audited through the one
 * deterministic core ({@link import("../audit/index.ts").auditWorkspace}),
 * so the renderers are always tested against reports the pipeline actually
 * produces — never hand-shaped lookalikes that could drift from the
 * contract. The five kinds cover the presentation surface:
 *
 * - `clean` — a small healthy workspace (index 0, complete);
 * - `sloppy` — hotspots of every ranked kind (complexity, clone group,
 *   import cycle) with a non-zero index;
 * - `mixed-language` — TypeScript plus non-TS sources reported as
 *   `unsupported` coverage (never as cleanliness, §3.3);
 * - `incomplete` — a parse failure degrading metrics to `incomplete` with a
 *   `partial` headline (§3.4);
 * - `function-free` — declaration-only source with `not-applicable` ratios
 *   and an honest zero index (§5.1).
 *
 * The audit timestamp is pinned so rendered output is byte-deterministic;
 * the caller owns the temp dir via {@link FixtureReport.cleanup}.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/index.ts";
import type { AuditReport } from "../contract/index.ts";

/** The fixture repository shapes (see the module docblock). */
export const FIXTURE_KINDS = [
	"clean",
	"sloppy",
	"mixed-language",
	"incomplete",
	"function-free",
] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** A rendered-fixture input: the audited temp repo, its §6.4 report, and its cleanup. */
export interface FixtureReport {
	kind: FixtureKind;
	root: string;
	report: AuditReport;
	cleanup: () => Promise<void>;
}

/** The pinned audit timestamp — rendered fixtures are byte-deterministic. */
const FIXTURE_NOW = new Date("2026-01-01T00:00:00.000Z");

/** Write `content` to `relPath` under `root`, creating parent dirs. */
async function put(root: string, relPath: string, content: string): Promise<void> {
	const abs = join(root, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** An eroded function (CC 12 > threshold 10): a `complexity.hotspot` finding. */
function tangledFunction(name: string): string {
	const branches = Array.from(
		{ length: 11 },
		(_, i) => `\tif (n > ${i}) {\n\t\tout += ${i};\n\t}`,
	).join("\n");
	return `export function ${name}(n: number): number {\n\tlet out = 0;\n${branches}\n\treturn out;\n}\n`;
}

/** 63 normalized tokens over 7 lines — above the clone minimums (SPEC §5.3). */
const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" +
	"\tconst s = a + b;\n" +
	"\tif (a > 0 && b > 0) return 1;\n" +
	"\tif (a > 1 && b > 1) return 2;\n" +
	"\tif (a > 2 && b > 2) return 3;\n" +
	"\treturn s;\n" +
	"}\n";

/** Seed the shared clean base: two production modules and one test file. */
async function seedCleanBase(root: string, name: string): Promise<void> {
	await put(root, "package.json", JSON.stringify({ name, version: "1.0.0" }));
	await put(
		root,
		"src/alpha.ts",
		"export function alpha(input: number): number {\n\tif (input > 0) {\n\t\treturn input * 2;\n\t}\n\treturn 0;\n}\n",
	);
	await put(
		root,
		"src/beta.ts",
		'import { alpha } from "./alpha.ts";\nexport const beta = alpha(1);\n',
	);
	await put(
		root,
		"src/alpha.test.ts",
		'import { alpha } from "./alpha.ts";\nexport const t = alpha(2);\n',
	);
}

/** Seed the fixture repository of `kind` under `root`. */
export async function seedFixtureRepo(root: string, kind: FixtureKind): Promise<void> {
	switch (kind) {
		case "clean":
			await seedCleanBase(root, "fixture-clean");
			return;
		case "sloppy": {
			await put(root, "package.json", JSON.stringify({ name: "fixture-sloppy", version: "1.0.0" }));
			await put(root, "src/tangled.ts", tangledFunction("tangled"));
			await put(root, "src/clone-a.ts", CLONE_FN);
			await put(root, "src/clone-b.ts", CLONE_FN);
			await put(root, "src/cyc-a.ts", 'import { b } from "./cyc-b.ts";\nexport const a = b;\n');
			await put(root, "src/cyc-b.ts", 'import { a } from "./cyc-a.ts";\nexport const b = a;\n');
			return;
		}
		case "mixed-language": {
			await seedCleanBase(root, "fixture-mixed-language");
			await put(root, "lib/tool.py", "def tool():\n    return 1\n");
			await put(root, "lib/tool.go", "package main\n\nfunc tool() int {\n\treturn 1\n}\n");
			return;
		}
		case "incomplete": {
			await put(
				root,
				"package.json",
				JSON.stringify({ name: "fixture-incomplete", version: "1.0.0" }),
			);
			await put(root, "src/a.ts", 'import { b } from "./b.ts";\nexport const a = b;\n');
			await put(root, "src/b.ts", 'import { a } from "./a.ts";\nexport const b = a;\n');
			await put(root, "src/broken.ts", "export const nope = ;\n");
			return;
		}
		case "function-free": {
			await put(
				root,
				"package.json",
				JSON.stringify({ name: "fixture-function-free", version: "1.0.0" }),
			);
			await put(root, "src/types.d.ts", "export declare const value: number;\n");
			return;
		}
	}
}

/**
 * Audit a fresh fixture repository of `kind` through the deterministic core
 * (pinned timestamp; the caller must {@link FixtureReport.cleanup}).
 */
export async function auditFixture(kind: FixtureKind): Promise<FixtureReport> {
	const root = await mkdtemp(join(tmpdir(), `trellis-fixture-${kind}-`));
	try {
		await seedFixtureRepo(root, kind);
		const report = await auditWorkspace(root, { now: FIXTURE_NOW });
		return {
			kind,
			root,
			report,
			cleanup: () => rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
