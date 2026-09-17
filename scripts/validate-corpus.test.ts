import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ANALYZER_VERSION } from "../src/contract/index.ts";
import { formatMarkdown } from "./corpus-report.ts";
import {
	collectEnvironment,
	loadManifest,
	main,
	measureInChildProcess,
	measureInProcess,
	median,
	observeEntry,
	parseArgs,
	readPeakRssMb,
	runCorpusValidation,
} from "./validate-corpus.ts";

const CORPUS_ROOT = resolve(import.meta.dir, "../corpus");
const REPO_ROOT = resolve(import.meta.dir, "..");

describe("loadManifest", () => {
	test("parses the committed corpus manifest", () => {
		const manifest = loadManifest(CORPUS_ROOT);
		expect(manifest.version).toBe(1);
		expect(manifest.runs).toBeGreaterThan(0);
		expect(manifest.entries.map((entry) => entry.id)).toContain("trellis-self");
		expect(manifest.pairs.map((pair) => pair.id)).toEqual([
			"clone-removal",
			"branch-growth",
			"cycle-introduction",
			"dilution",
		]);
		// Every pair endpoint names a declared entry.
		const ids = new Set(manifest.entries.map((entry) => entry.id));
		for (const pair of manifest.pairs) {
			expect(ids.has(pair.before)).toBe(true);
			expect(ids.has(pair.after)).toBe(true);
		}
	});

	test("rejects a manifest with unknown keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-corpus-manifest-"));
		try {
			await writeFile(
				join(dir, "manifest.json"),
				JSON.stringify({ version: 1, runs: 1, entries: [], pairs: [], bogus: true }),
			);
			expect(() => loadManifest(dir)).toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("median", () => {
	test("takes the middle of odd counts and the upper middle of even counts", () => {
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 10, 2])).toBe(4);
		expect(median([7])).toBe(7);
	});
});

describe("readPeakRssMb", () => {
	test("reports a positive peak RSS", () => {
		expect(readPeakRssMb()).toBeGreaterThan(0);
	});
});

describe("collectEnvironment", () => {
	test("records versions, machine facts, and the git revision", () => {
		const env = collectEnvironment(REPO_ROOT);
		expect(env.analyzerVersion).toBe(ANALYZER_VERSION);
		expect(env.scoringVersion).toContain("provisional");
		expect(env.bun).toBeTruthy();
		expect(env.typescript).toBeTruthy();
		expect(env.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(env.memoryMb).toBeGreaterThan(0);
	});
});

describe("measureInProcess", () => {
	test("audits a fixture and summarizes its report", async () => {
		const run = await measureInProcess(resolve(CORPUS_ROOT, "fixtures/clean-small"), "clean-small");
		expect(run.summary.index).toBe(0);
		expect(run.summary.completeness).toBe("complete");
		expect(run.measurement.durationMs).toBeGreaterThanOrEqual(0);
		expect(run.measurement.peakRssMb).toBeGreaterThan(0);
	});
});

describe("measureInChildProcess", () => {
	test("measures the same summary in a fresh process", async () => {
		const root = resolve(CORPUS_ROOT, "fixtures/clean-small");
		const child = measureInChildProcess(root, "clean-small");
		expect(child.summary.index).toBe(0);
		expect(child.summary.completeness).toBe("complete");
		expect(child.measurement.peakRssMb).toBeGreaterThan(0);
	}, 30_000);

	test("throws with the child's stderr when the measurement fails", async () => {
		expect(() => measureInChildProcess(resolve(CORPUS_ROOT, "fixtures/nope"), "nope")).toThrow(
			/measurement child failed for nope/,
		);
	}, 30_000);
});

describe("observeEntry", () => {
	test("records budget breaches instead of throwing", async () => {
		const manifest = loadManifest(CORPUS_ROOT);
		const entry = manifest.entries.find((candidate) => candidate.id === "clean-small");
		if (entry === undefined) throw new Error("clean-small missing from manifest");
		const tight = { ...entry, budget: { maxMedianMs: 0.001, maxPeakRssMb: 0.001 } };
		const observation = await observeEntry(CORPUS_ROOT, tight, 1, "in-process");
		expect(observation.budgetBreaches).toHaveLength(2);
		expect(observation.budgetBreaches[0]).toContain("exceeds budget");
		expect(observation.id).toBe("clean-small");
		expect(observation.runs).toHaveLength(1);
	});
});

describe("parseArgs", () => {
	test("parses flags and values with defaults", () => {
		const args = parseArgs([
			"--corpus",
			"x",
			"--runs",
			"5",
			"--no-self",
			"--in-process",
			"--out",
			"y",
		]);
		expect(args).toEqual({
			corpus: "x",
			runs: 5,
			includeSelf: false,
			mode: "in-process",
			out: "y",
		});
		expect(parseArgs([])).toEqual({ includeSelf: true, mode: "child" });
		expect(parseArgs(["--measure", "z", "--id", "w"])).toMatchObject({ measure: "z", id: "w" });
	});

	test("rejects unknown flags and missing values", () => {
		expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag: --bogus/);
		expect(() => parseArgs(["--runs"])).toThrow(/flag --runs needs a value/);
	});
});

describe("main", () => {
	test("--measure writes the measured run as JSON", async () => {
		let written = "";
		const code = await main(
			["--measure", resolve(CORPUS_ROOT, "fixtures/clean-small"), "--id", "m"],
			(text) => {
				written += text;
			},
		);
		expect(code).toBe(0);
		const run = JSON.parse(written);
		expect(run.summary.index).toBe(0);
		expect(run.measurement.peakRssMb).toBeGreaterThan(0);
	});

	test("writes the record file and returns 0 when the corpus validates", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-corpus-main-"));
		try {
			let written = "";
			const code = await main(
				[
					"--corpus",
					CORPUS_ROOT,
					"--runs",
					"1",
					"--no-self",
					"--in-process",
					"--out",
					join(dir, "record.json"),
				],
				(text) => {
					written += text;
				},
			);
			expect(code).toBe(0);
			expect(written).toContain("overall: ok");
			const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
			expect(record.ok).toBe(true);
			expect(record.entries.length).toBe(11);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("returns 1 and still writes the record when a budget fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-corpus-fail-"));
		try {
			const manifest = {
				version: 1,
				runs: 1,
				entries: [
					{
						id: "tight",
						path: resolve(CORPUS_ROOT, "fixtures/clean-small"),
						role: "single",
						budget: { maxMedianMs: 0.001, maxPeakRssMb: 0.001 },
						checks: { index: { eq: 0 } },
					},
				],
				pairs: [],
			};
			await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
			let written = "";
			const code = await main(["--corpus", dir, "--in-process"], (text) => {
				written += text;
			});
			expect(code).toBe(1);
			expect(written).toContain("overall: FAIL");
			expect(written).toContain("exceeds budget");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("runCorpusValidation", () => {
	test("validates the fixture corpus: budgets, checks, and pair expectations all hold", async () => {
		const record = await runCorpusValidation({
			corpusRoot: CORPUS_ROOT,
			runs: 1,
			includeSelf: false,
			mode: "in-process",
		});
		expect(record.entries).toHaveLength(11);
		expect(record.pairs).toHaveLength(4);
		expect(record.ok).toBe(true);
		for (const pair of record.pairs) {
			expect(pair.failures).toEqual([]);
		}
		// The review checks are attached to the single-role entries.
		expect(Object.keys(record.checkResults).sort()).toEqual([
			"clean-small",
			"incomplete-parse",
			"test-separation",
		]);
		// The record renders through the markdown view unchanged.
		const markdown = formatMarkdown(record);
		expect(markdown).toContain("### dilution (index 42 → 42)");
		expect(markdown).toContain("overall: ok");
	}, 60_000);

	test("throws when a pair references an unmeasured entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-corpus-pair-"));
		try {
			const fixture = resolve(CORPUS_ROOT, "fixtures/clean-small");
			const manifest = {
				version: 1,
				runs: 1,
				entries: [
					{
						id: "only",
						path: fixture,
						role: "single",
						budget: { maxMedianMs: 5000, maxPeakRssMb: 1024 },
					},
				],
				pairs: [{ id: "broken", before: "only", after: "missing" }],
			};
			await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
			await expect(
				runCorpusValidation({ corpusRoot: dir, runs: 1, mode: "in-process" }),
			).rejects.toThrow("pair broken references an unmeasured entry");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
