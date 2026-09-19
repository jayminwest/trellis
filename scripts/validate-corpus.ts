#!/usr/bin/env bun
/**
 * Fixed-corpus validation harness (SPEC §14, trellis-e924).
 *
 * Runs the deterministic audit core over the committed corpus in `corpus/`
 * (fixture workspaces plus the trellis checkout itself), records runtime and
 * peak-memory observations against the manifest's explicit budgets, and
 * verifies the paired-refactor expectations — clone removal, branch growth,
 * cycle introduction, and clean-addition dilution — plus the single-entry
 * review checks (small-repo behavior, test separation, incomplete-analysis
 * handling). The record feeds `docs/corpus-validation.md`.
 *
 * The audits themselves are the plain core call: no model, no network, no
 * project commands. Timing/memory are record metadata only, never payload
 * (SPEC §3.5).
 *
 * CLI:
 *   bun run scripts/validate-corpus.ts [--corpus <dir>] [--runs N]
 *       [--no-self] [--in-process] [--out <record.json>]
 *   bun run scripts/validate-corpus.ts --measure <abs-root> --id <entry-id>
 *
 * Default measurement spawns a fresh child process per run so peak RSS
 * (VmHWM) is clean per audit; `--in-process` is the fast path for tests.
 * Exit 0 when every budget, check, and pair expectation holds, else 1.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { auditWorkspace } from "../src/audit/audit.ts";
import { ANALYZER_VERSION, SCHEMA_VERSION, SCORING_VERSION } from "../src/contract/index.ts";
import {
	assessPair,
	type CheckResult,
	type EntrySummary,
	evaluateChecks,
	formatMarkdown,
	type PairAssessment,
	summarizeReport,
} from "./corpus-report.ts";

const SCRIPT_PATH = import.meta.filename;
const DEFAULT_CORPUS_ROOT = resolve(import.meta.dir, "../corpus");
const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "..");

const checkSchema = z
	.object({
		eq: z.union([z.number(), z.string(), z.boolean()]).optional(),
		gt: z.number().optional(),
		ge: z.number().optional(),
		lt: z.number().optional(),
		le: z.number().optional(),
		state: z.string().optional(),
	})
	.strict();

const budgetSchema = z
	.object({ maxMedianMs: z.number().positive(), maxPeakRssMb: z.number().positive() })
	.strict();

const entrySchema = z
	.object({
		id: z.string().min(1),
		path: z.string().min(1),
		role: z.enum(["single", "pair-before", "pair-after"]),
		review: z.string().optional(),
		pair: z.string().optional(),
		budget: budgetSchema,
		checks: z.record(z.string(), checkSchema).optional(),
	})
	.strict();

const pairSchema = z
	.object({
		id: z.string().min(1),
		before: z.string().min(1),
		after: z.string().min(1),
		expectDecrease: z.array(z.string()).default([]),
		expectIncrease: z.array(z.string()).default([]),
		expectUnchanged: z.array(z.string()).default([]),
		indexDelta: z
			.object({ min: z.number().optional(), max: z.number().optional() })
			.strict()
			.optional(),
	})
	.strict();

const manifestSchema = z
	.object({
		$comment: z.string().optional(),
		version: z.literal(1),
		runs: z.number().int().positive(),
		entries: z.array(entrySchema).min(1),
		pairs: z.array(pairSchema),
	})
	.strict();

export type MetricCheck = z.infer<typeof checkSchema>;
export type CorpusEntry = z.infer<typeof entrySchema>;
export type CorpusPair = z.infer<typeof pairSchema>;
export type CorpusManifest = z.infer<typeof manifestSchema>;

/** Load and validate `manifest.json` under `corpusRoot`. */
export function loadManifest(corpusRoot: string): CorpusManifest {
	const raw = readFileSync(resolve(corpusRoot, "manifest.json"), "utf8");
	return manifestSchema.parse(JSON.parse(raw));
}

/** One measured audit run. */
export interface RunMeasurement {
	durationMs: number;
	peakRssMb: number;
}

/** A run's summary plus its timing/memory observation. */
export interface MeasuredRun {
	summary: EntrySummary;
	measurement: RunMeasurement;
}

/** Peak RSS of the current process in MiB (Linux VmHWM; falls back to current RSS). */
export function readPeakRssMb(): number {
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		const match = status.match(/^VmHWM:\s+(\d+)\s*kB$/m);
		if (match?.[1] !== undefined) return Number.parseInt(match[1], 10) / 1024;
	} catch {
		// Non-Linux: fall back to current RSS below.
	}
	return process.memoryUsage().rss / (1024 * 1024);
}

/** Audit `root` in this process (fast path; RSS is the shared process peak). */
export async function measureInProcess(root: string, id: string): Promise<MeasuredRun> {
	const startedAt = performance.now();
	const report = await auditWorkspace(root);
	return {
		summary: summarizeReport(id, report),
		measurement: { durationMs: performance.now() - startedAt, peakRssMb: readPeakRssMb() },
	};
}

/** Audit `root` in a fresh child process so peak RSS is clean per run. */
export function measureInChildProcess(root: string, id: string): MeasuredRun {
	const result = spawnSync(process.execPath, [SCRIPT_PATH, "--measure", root, "--id", id], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`measurement child failed for ${id}: ${result.stderr.trim()}`);
	}
	return JSON.parse(result.stdout) as MeasuredRun;
}

/** Median of a non-empty list (upper middle for even counts — deterministic). */
export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** All runs of one corpus entry plus its budget verdict. */
export interface EntryObservation {
	id: string;
	entry: CorpusEntry;
	summary: EntrySummary;
	runs: RunMeasurement[];
	medianMs: number;
	peakRssMb: number;
	budgetBreaches: string[];
}

/** Run `entry` `runs` times and fold the observations against its budget. */
export async function observeEntry(
	corpusRoot: string,
	entry: CorpusEntry,
	runs: number,
	mode: "child" | "in-process",
): Promise<EntryObservation> {
	const absRoot = resolve(corpusRoot, entry.path);
	const measured: MeasuredRun[] = [];
	for (let run = 0; run < runs; run += 1) {
		measured.push(
			mode === "child"
				? measureInChildProcess(absRoot, entry.id)
				: await measureInProcess(absRoot, entry.id),
		);
	}
	const byDuration = [...measured].sort(
		(a, b) => a.measurement.durationMs - b.measurement.durationMs,
	);
	const medianRun = byDuration[Math.floor(byDuration.length / 2)] ?? measured[0];
	if (medianRun === undefined) throw new Error(`no runs recorded for ${entry.id}`);
	const medianMs = medianRun.measurement.durationMs;
	const peakRssMb = Math.max(...measured.map((run) => run.measurement.peakRssMb));
	const budgetBreaches: string[] = [];
	if (medianMs > entry.budget.maxMedianMs) {
		budgetBreaches.push(
			`median ${medianMs.toFixed(0)}ms exceeds budget ${entry.budget.maxMedianMs}ms`,
		);
	}
	if (peakRssMb > entry.budget.maxPeakRssMb) {
		budgetBreaches.push(
			`peak RSS ${peakRssMb.toFixed(0)}MiB exceeds budget ${entry.budget.maxPeakRssMb}MiB`,
		);
	}
	return {
		id: entry.id,
		entry,
		summary: medianRun.summary,
		runs: measured.map((run) => run.measurement),
		medianMs,
		peakRssMb,
		budgetBreaches,
	};
}

/** Machine and version facts recorded with the run (metadata, never payload). */
export interface CorpusEnvironment {
	bun: string;
	typescript: string;
	platform: string;
	arch: string;
	cpu: string;
	memoryMb: number;
	analyzerVersion: string;
	scoringVersion: string;
	schemaVersion: string;
	revision: string;
}

/** Collect the environment block; the git revision degrades to `unknown`. */
export function collectEnvironment(repoRoot: string): CorpusEnvironment {
	const tsPkg = JSON.parse(
		readFileSync(resolve(repoRoot, "node_modules/typescript/package.json"), "utf8"),
	) as { version: string };
	const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	return {
		bun: Bun.version,
		typescript: tsPkg.version,
		platform: process.platform,
		arch: process.arch,
		cpu: cpus()[0]?.model ?? "unknown",
		memoryMb: Math.round(totalmem() / (1024 * 1024)),
		analyzerVersion: ANALYZER_VERSION,
		scoringVersion: SCORING_VERSION,
		schemaVersion: SCHEMA_VERSION,
		revision: git.status === 0 ? git.stdout.trim() : "unknown",
	};
}

/** The full validation record (input to `docs/corpus-validation.md`). */
export interface CorpusRecord {
	environment: CorpusEnvironment;
	entries: EntryObservation[];
	checkResults: Record<string, CheckResult[]>;
	pairs: PairAssessment[];
	ok: boolean;
}

/** Run the whole corpus validation and return its record. */
export async function runCorpusValidation(
	options: {
		corpusRoot?: string;
		runs?: number;
		includeSelf?: boolean;
		mode?: "child" | "in-process";
		repoRoot?: string;
	} = {},
): Promise<CorpusRecord> {
	const corpusRoot = resolve(options.corpusRoot ?? DEFAULT_CORPUS_ROOT);
	const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
	const manifest = loadManifest(corpusRoot);
	const runs = options.runs ?? manifest.runs;
	const mode = options.mode ?? "child";
	const includeSelf = options.includeSelf ?? true;
	const entries = manifest.entries.filter((entry) => includeSelf || entry.id !== "trellis-self");
	const observations: EntryObservation[] = [];
	for (const entry of entries) {
		observations.push(await observeEntry(corpusRoot, entry, runs, mode));
	}
	const byId = new Map(observations.map((observation) => [observation.entry.id, observation]));
	const checkResults: Record<string, CheckResult[]> = {};
	for (const observation of observations) {
		if (observation.entry.checks !== undefined) {
			checkResults[observation.entry.id] = evaluateChecks(
				observation.summary,
				observation.entry.checks,
			);
		}
	}
	const pairs: PairAssessment[] = [];
	for (const pair of manifest.pairs) {
		const before = byId.get(pair.before);
		const after = byId.get(pair.after);
		if (before === undefined || after === undefined) {
			throw new Error(`pair ${pair.id} references an unmeasured entry`);
		}
		pairs.push(assessPair(pair, before.summary, after.summary));
	}
	const ok =
		observations.every((observation) => observation.budgetBreaches.length === 0) &&
		Object.values(checkResults)
			.flat()
			.every((result) => result.ok) &&
		pairs.every((pair) => pair.failures.length === 0);
	return {
		environment: collectEnvironment(repoRoot),
		entries: observations,
		checkResults,
		pairs,
		ok,
	};
}

/** The parsed CLI flags. */
export interface CliArgs {
	corpus?: string;
	runs?: number;
	includeSelf: boolean;
	mode: "child" | "in-process";
	out?: string;
	measure?: string;
	id?: string;
}

/** Flags taking a value in the next argv slot. */
const VALUE_FLAGS: Record<string, (args: CliArgs, value: string) => void> = {
	"--corpus": (args, value) => {
		args.corpus = value;
	},
	"--runs": (args, value) => {
		args.runs = Number.parseInt(value, 10);
	},
	"--out": (args, value) => {
		args.out = value;
	},
	"--measure": (args, value) => {
		args.measure = value;
	},
	"--id": (args, value) => {
		args.id = value;
	},
};

/** Parse the CLI flags (see the module docblock). */
export function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = { includeSelf: true, mode: "child" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index] ?? "";
		if (flag === "--no-self") {
			args.includeSelf = false;
			continue;
		}
		if (flag === "--in-process") {
			args.mode = "in-process";
			continue;
		}
		const apply = VALUE_FLAGS[flag];
		if (apply === undefined) throw new Error(`unknown flag: ${flag}`);
		const value = argv[++index];
		if (value === undefined) throw new Error(`flag ${flag} needs a value`);
		apply(args, value);
	}
	return args;
}

/**
 * Run the CLI over `argv`, writing to `write` (stdout by default) and
 * returning the exit code — 0 when the corpus validates (or a measurement
 * was taken), 1 when a budget, check, or pair expectation fails (the
 * failing record is still written).
 */
export async function main(
	argv: readonly string[],
	write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
	const args = parseArgs(argv);
	if (args.measure !== undefined) {
		const run = await measureInProcess(resolve(args.measure), args.id ?? "measure");
		write(`${JSON.stringify(run)}\n`);
		return 0;
	}
	const record = await runCorpusValidation({
		corpusRoot: args.corpus,
		runs: args.runs,
		includeSelf: args.includeSelf,
		mode: args.mode,
	});
	if (args.out !== undefined) {
		writeFileSync(resolve(args.out), `${JSON.stringify(record, null, 2)}\n`);
	}
	write(formatMarkdown(record));
	return record.ok ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
