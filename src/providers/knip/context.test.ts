import { describe, expect, test } from "bun:test";
import type { SourceSet } from "../../contract/index.ts";
import type { ReachabilitySelectionFile } from "./context.ts";
import { prepareReachabilityContext } from "./context.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/** One measured selection file — the audit's existing production/test classification, reused. */
function file(path: string, sourceSet: SourceSet): ReachabilitySelectionFile {
	return { path, sourceSet };
}

/**
 * The AC5 fixture selection: production files — a CLI entry, a utility, a
 * barrel (`src/client/index.ts`) with the implementation it exposes
 * (`src/client/impl.ts`), a script — plus one measured test file.
 */
function fixtureSelection(): ReachabilitySelectionFile[] {
	return [
		file("src/cli/main.ts", "production"),
		file("src/client/impl.ts", "production"),
		file("src/client/index.ts", "production"),
		file("src/util.ts", "production"),
		file("scripts/run.ts", "production"),
		file("src/util.test.ts", "test"),
	];
}

/** The assumption ids recorded by one prepared context. */
function assumptionIds(context: ReturnType<typeof prepareReachabilityContext>): string[] {
	return context.assumptions.map((entry) => entry.id);
}

describe("prepareReachabilityContext (trellis-5da5 — pure context preparation)", () => {
	test("selects the measured production files as the project scope and never a test file", () => {
		const context = prepareReachabilityContext(compileReachabilityPolicy({}), fixtureSelection());
		expect(context.projectFiles).toEqual([
			"scripts/run.ts",
			"src/cli/main.ts",
			"src/client/impl.ts",
			"src/client/index.ts",
			"src/util.ts",
		]);
		expect(context.testFiles).toEqual(["src/util.test.ts"]);
		expect(context.projectFiles).not.toContain("src/util.test.ts");
	});

	test("records undefined reachability for an empty declaration — never a dead-code claim", () => {
		const context = prepareReachabilityContext(compileReachabilityPolicy({}), fixtureSelection());
		expect(context.entryRoots).toEqual([]);
		expect(context.publicSurfaces).toEqual([]);
		expect(context.testRoots).toEqual([]);
		expect(assumptionIds(context)).toEqual([
			"dependency-context-unverified",
			"no-entries-declared",
			"no-public-surfaces-declared",
			"plugin-discovery-disabled",
			"tests-excluded",
		]);
		expect(context.identityOptions["reachability-policy-digest"]).toBe(`sha256:${context.digest}`);
	});

	test("adding a legitimate script entry changes reachability appropriately (AC5)", () => {
		const without = prepareReachabilityContext(compileReachabilityPolicy({}), fixtureSelection());
		const withEntry = prepareReachabilityContext(
			compileReachabilityPolicy({ entries: ["scripts/run.ts"] }),
			fixtureSelection(),
		);
		// The root grows by exactly the declared script; the project scope is unchanged.
		expect(without.entryRoots).toEqual([]);
		expect(withEntry.entryRoots).toEqual(["scripts/run.ts"]);
		expect(withEntry.projectFiles).toEqual(without.projectFiles);
		expect(assumptionIds(withEntry)).not.toContain("no-entries-declared");
		expect(assumptionIds(withEntry)).toContain("no-public-surfaces-declared");
		expect(withEntry.digest).not.toBe(without.digest);
		expect(withEntry.entryRoots.every((root) => withEntry.projectFiles.includes(root))).toBe(true);
	});

	test("test participation supplies reachability evidence without diluting production (AC2)", () => {
		const excluded = prepareReachabilityContext(
			compileReachabilityPolicy({ tests: "excluded" }),
			fixtureSelection(),
		);
		expect(excluded.testRoots).toEqual([]);
		expect(assumptionIds(excluded)).toContain("tests-excluded");

		const participating = prepareReachabilityContext(
			compileReachabilityPolicy({ tests: "roots" }),
			fixtureSelection(),
		);
		expect(participating.testRoots).toEqual(["src/util.test.ts"]);
		expect(assumptionIds(participating)).not.toContain("tests-excluded");
		// The production denominator is untouched by participation.
		expect(participating.projectFiles).toEqual(excluded.projectFiles);
		expect(participating.testRoots.every((root) => participating.testFiles.includes(root))).toBe(
			true,
		);
		for (const root of participating.testRoots) {
			expect(participating.projectFiles).not.toContain(root);
		}
	});

	test("a declared test entry is an explicit per-file root — still never production", () => {
		const context = prepareReachabilityContext(
			compileReachabilityPolicy({ entries: ["src/util.test.ts"] }),
			fixtureSelection(),
		);
		expect(context.entryRoots).toEqual([]);
		expect(context.testRoots).toEqual(["src/util.test.ts"]);
		expect(context.projectFiles).not.toContain("src/util.test.ts");
		expect(assumptionIds(context)).toContain("tests-excluded");
	});

	test("a barrel re-export is a distinct surface from the implementation it exposes (AC5)", () => {
		const context = prepareReachabilityContext(
			compileReachabilityPolicy({
				entries: ["src/cli/main.ts"],
				public: [{ path: "src/client/index.ts" }, { path: "src/client/index.ts", export: "audit" }],
			}),
			fixtureSelection(),
		);
		// The surface records name the declared barrel only — the
		// implementation it exposes is never rewritten into a surface.
		expect(context.publicSurfaces).toEqual([
			{ path: "src/client/index.ts" },
			{ path: "src/client/index.ts", export: "audit" },
		]);
		const surfacePaths = new Set(context.publicSurfaces.map((surface) => surface.path));
		expect(surfacePaths.has("src/client/impl.ts")).toBe(false);
		// And the converse: the implementation stays an ordinary project file —
		// never public, never a root by the barrel's declaration.
		expect(context.projectFiles).toContain("src/client/impl.ts");
		expect(context.entryRoots).toEqual(["src/cli/main.ts"]);
	});

	test("records unresolvable declarations as assumptions with their paths (AC3)", () => {
		const context = prepareReachabilityContext(
			compileReachabilityPolicy({
				entries: ["src/gone.ts", "scripts/run.ts"],
				public: [{ path: "src/vanished.ts" }, { path: "src/util.test.ts", export: "helper" }],
			}),
			fixtureSelection(),
		);
		const byId = new Map(context.assumptions.map((entry) => [entry.id, entry.paths]));
		expect(byId.get("declared-entry-not-in-selection")).toEqual(["src/gone.ts"]);
		expect(byId.get("declared-public-surface-not-in-selection")).toEqual(["src/vanished.ts"]);
		expect(byId.get("public-surface-not-production")).toEqual(["src/util.test.ts"]);
		// Resolvable declarations still resolve; only the gaps are assumptions.
		expect(context.entryRoots).toEqual(["scripts/run.ts"]);
		expect(context.publicSurfaces).toEqual([]);
		expect(assumptionIds(context)).not.toContain("no-entries-declared");
		expect(assumptionIds(context)).not.toContain("no-public-surfaces-declared");
	});

	test("collapses duplicate selection paths deterministically", () => {
		const selection = [...fixtureSelection(), file("src/util.ts", "production")];
		const context = prepareReachabilityContext(compileReachabilityPolicy({}), selection);
		expect(context.projectFiles.filter((path) => path === "src/util.ts").length).toBe(1);
	});

	test("is pure and deterministic — the same inputs prepare the same context", () => {
		const policy = compileReachabilityPolicy({ entries: ["scripts/run.ts"], tests: "roots" });
		expect(prepareReachabilityContext(policy, fixtureSelection())).toEqual(
			prepareReachabilityContext(policy, fixtureSelection()),
		);
	});
});
