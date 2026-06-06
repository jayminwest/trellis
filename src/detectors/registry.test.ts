import { describe, expect, test } from "bun:test";
import { loadRubric } from "../rubric/index.ts";
import { commonBinding, DetectorRegistry, languageBinding, REGISTRY } from "./registry.ts";
import {
	type DetectionContext,
	type Detector,
	type DetectorResult,
	detectorResultSchema,
} from "./types.ts";

/** A detector that ignores its context and returns a tagged pass. */
const stub =
	(tag: string): Detector =>
	async () => ({
		numerator: 1,
		denominator: 1,
		rationale: tag,
	});

/** Minimal context — registry resolution never touches it. */
const ctx = { app: { path: ".", languages: [] } } as unknown as DetectionContext;

/**
 * Empty-repo context: real common detectors execute against this in the
 * acceptance sweep, so its capabilities answer "nothing here" honestly —
 * `readFile`→null, `glob`→[], `run`→exit 127 (tool missing). Every detector
 * must still return a schema-valid result against it.
 */
const emptyCtx: DetectionContext = {
	repoPath: "/tmp/empty",
	app: { path: ".", languages: ["typescript"] },
	run: async () => ({ exitCode: 127, stdout: "", stderr: "", timedOut: false }),
	readFile: async () => null,
	glob: async () => [],
};

describe("DetectorRegistry.resolve", () => {
	test("returns the common detector for a common binding", async () => {
		const reg = new DetectorRegistry({ codeowners: commonBinding(stub("common")) });
		const result = await reg.resolve("codeowners", ["typescript"])(ctx);
		expect(result.rationale).toBe("common");
	});

	test("picks the per-language adapter for the app's language", async () => {
		const reg = new DetectorRegistry({
			lint_config: languageBinding({ typescript: stub("biome"), python: stub("ruff") }),
		});
		expect((await reg.resolve("lint_config", ["python"])(ctx)).rationale).toBe("ruff");
		expect((await reg.resolve("lint_config", ["typescript"])(ctx)).rationale).toBe("biome");
	});

	test("precedence follows app-language order, not binding order", async () => {
		const reg = new DetectorRegistry({
			lint_config: languageBinding({ typescript: stub("biome"), python: stub("ruff") }),
		});
		// App declares python first → python adapter wins even though both are bound.
		expect((await reg.resolve("lint_config", ["python", "typescript"])(ctx)).rationale).toBe(
			"ruff",
		);
	});

	test("an unbound criterion resolves to a no-detector stub (never a crash)", async () => {
		const reg = new DetectorRegistry({});
		const result = await reg.resolve("anything", ["typescript"])(ctx);
		expect(result.numerator).toBeNull();
		expect(result.naKind).toBe("no-detector");
		expect(result.rationale).toContain("no detector bound");
	});

	test("a per-language binding with no adapter for the app falls back to no-detector", async () => {
		const reg = new DetectorRegistry({
			lint_config: languageBinding({ typescript: stub("biome") }),
		});
		const result = await reg.resolve("lint_config", ["swift"])(ctx);
		expect(result.naKind).toBe("no-detector");
		expect(result.rationale).toContain("swift");
		expect(result.rationale).toContain("typescript");
	});

	test("a per-language binding with no app languages falls back to no-detector", async () => {
		const reg = new DetectorRegistry({
			lint_config: languageBinding({ typescript: stub("biome") }),
		});
		const result = await reg.resolve("lint_config", [])(ctx);
		expect(result.naKind).toBe("no-detector");
		expect(result.rationale).toContain("none");
	});

	test("has() reports explicit bindings vs fallback", () => {
		const reg = new DetectorRegistry({ codeowners: commonBinding(stub("c")) });
		expect(reg.has("codeowners")).toBe(true);
		expect(reg.has("lint_config")).toBe(false);
	});
});

describe("registry covers the rubric (acceptance)", () => {
	const rubric = loadRubric();
	const deterministic = rubric.criteria.filter((c) => c.discoveryVia === "deterministic");

	test("there are 70 deterministic criteria", () => {
		expect(deterministic.length).toBe(70);
	});

	test("every deterministic criterion resolves to a valid detector result", async () => {
		for (const c of deterministic) {
			const result: DetectorResult = await REGISTRY.resolve(
				c.id,
				c.scope === "app" ? ["typescript"] : [],
			)(emptyCtx);
			expect(detectorResultSchema.safeParse(result).success).toBe(true);
		}
	});

	test("every deterministic app criterion resolves to a valid result for a Python app", async () => {
		const appCriteria = deterministic.filter((c) => c.scope === "app");
		for (const c of appCriteria) {
			const result = await REGISTRY.resolve(c.id, ["python"])(emptyCtx);
			expect(detectorResultSchema.safeParse(result).success).toBe(true);
		}
	});

	test("Python honest N/A accounting: TS-only concepts are N/A, deptry is gradable", async () => {
		const naFor = async (id: string) => (await REGISTRY.resolve(id, ["python"])(emptyCtx)).naKind;
		// TS stack-concepts with no Python analogue resolve to not-applicable (excluded
		// from coverage), never no-detector and never a fail.
		for (const id of [
			"explicit_any_detection",
			"greppable_exports",
			"barrel_file_reexport_detection",
			"strictest_type_checking",
		]) {
			expect(await naFor(id)).toBe("not-applicable");
		}
		// Unlike Swift, Python HAS an unused-dependency analogue (deptry), so an empty
		// repo fails the criterion rather than excusing it as not-applicable.
		const deptry = await REGISTRY.resolve("unused_dependencies_detection", ["python"])(emptyCtx);
		expect(deptry.numerator).toBe(0);
		expect(deptry.naKind).toBeUndefined();
	});

	test("no agent criterion is ever bound to a detector", () => {
		const agentIds = new Set(
			rubric.criteria.filter((c) => c.discoveryVia === "agent").map((c) => c.id),
		);
		for (const id of REGISTRY.boundIds()) {
			expect(agentIds.has(id)).toBe(false);
		}
	});

	test("every authored binding targets a known deterministic criterion", () => {
		const deterministicIds = new Set(deterministic.map((c) => c.id));
		for (const id of REGISTRY.boundIds()) {
			expect(deterministicIds.has(id)).toBe(true);
		}
	});
});
