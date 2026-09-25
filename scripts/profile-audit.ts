#!/usr/bin/env bun
import { heapStats } from "bun:jsc";
/**
 * Large-workspace memory profile for the native audit (trellis-92b4).
 *
 * Runs `auditWorkspace` in-process over one workspace and samples memory at
 * every progress event, after a forced full GC, so each sample is the heap
 * **retained** at that phase boundary (shared AST, graph, clone context …)
 * rather than transient garbage. Then measures what the report itself costs:
 * retained report heap, the zod contract parse (a full schema copy), and
 * compact / pretty JSON serialization (the CLI's `--out` and `--json`).
 *
 * Profiling only: forced GCs slow the run, so wall times here are not the
 * corpus runtime budgets. Default audit behavior is unchanged — offline, no
 * writes to the target, no scoring change.
 *
 * CLI:
 *   bun run scripts/profile-audit.ts <workspace> [--out profile.json]
 *
 * Prints a markdown table; `--out` writes the JSON record.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditWorkspace } from "../src/audit/audit.ts";
import type { AuditEvent } from "../src/audit/progress.ts";
import { auditReportSchema } from "../src/contract/index.ts";

const MIB = 1024 * 1024;

/** One memory sample at a named point. */
export interface MemorySample {
	point: string;
	elapsedMs: number;
	/** JS heap retained after a full GC (MiB). */
	heapMiB: number;
	/** Process resident set (MiB). */
	rssMiB: number;
}

/** The full profile record. */
export interface AuditProfile {
	workspace: string;
	files: number;
	functions: number;
	samples: MemorySample[];
	/** Peak process RSS over the whole run (Linux VmHWM; else max sampled RSS). */
	peakRssMiB: number;
	/** Heap retained by the finished report alone (MiB). */
	reportHeapMiB: number;
	/** Heap retained by one zod-parsed copy of the report (MiB). */
	schemaCopyHeapMiB: number;
	compactJsonMiB: number;
	prettyJsonMiB: number;
	compactJsonMs: number;
	prettyJsonMs: number;
	schemaParseMs: number;
	/** Most numerous live object types at the measured boundary. */
	topObjectTypes: { type: string; count: number }[];
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Retained heap after a synchronous full collection (MiB). */
function retainedHeapMiB(): number {
	// Two synchronous full collections: JSC scans conservatively, and a
	// single pass can leave just-released structures (the shared AST) behind.
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().heapSize / MIB;
}

/** Peak RSS: Linux VmHWM, falling back to current RSS elsewhere. */
function peakRssMiB(): number {
	try {
		const match = readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+)\s*kB$/m);
		if (match?.[1] !== undefined) return Number.parseInt(match[1], 10) / 1024;
	} catch {
		// Non-Linux: fall through.
	}
	return process.memoryUsage().rss / MIB;
}

/** A label for one progress event. */
function eventPoint(event: AuditEvent): string {
	if (event.type === "phase") return `phase:${event.phase}`;
	if (event.type === "analyzer") return `analyzer:${event.id}`;
	return event.type;
}

/** Wall time of `run` in ms, with its result. */
function timed<T>(run: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = run();
	return { value, ms: performance.now() - start };
}

/** Report-level costs: retained report heap, one zod copy, JSON serialization. */
interface ReportCost {
	reportHeapMiB: number;
	schemaCopyHeapMiB: number;
	compactJsonMiB: number;
	prettyJsonMiB: number;
	compactJsonMs: number;
	prettyJsonMs: number;
	schemaParseMs: number;
}

/** Serialize + contract-parse the report, measured in their own frames. */
function measureSerialization(holder: {
	report: unknown;
}): Omit<ReportCost, "reportHeapMiB" | "schemaCopyHeapMiB"> & { copy: unknown } {
	const parsed = timed(() => auditReportSchema.parse(holder.report));
	const compact = timed(() => Buffer.byteLength(JSON.stringify(parsed.value)));
	const pretty = timed(() => Buffer.byteLength(JSON.stringify(parsed.value, null, 2)));
	return {
		copy: parsed.value,
		compactJsonMiB: round(compact.value / MIB),
		prettyJsonMiB: round(pretty.value / MIB),
		compactJsonMs: Math.round(compact.ms),
		prettyJsonMs: Math.round(pretty.ms),
		schemaParseMs: Math.round(parsed.ms),
	};
}

/** Retained cost of the report and of one parsed copy, dropping each in turn. */
function measureReport(holder: { report: unknown }): ReportCost {
	const serialization = measureSerialization(holder);
	const copyHolder: { copy: unknown } = { copy: serialization.copy };
	serialization.copy = undefined;
	const withBoth = retainedHeapMiB();
	copyHolder.copy = undefined;
	const withReport = retainedHeapMiB();
	holder.report = undefined;
	const withNeither = retainedHeapMiB();
	const { copy: _copy, ...costs } = serialization;
	return {
		...costs,
		reportHeapMiB: round(withReport - withNeither),
		schemaCopyHeapMiB: round(withBoth - withReport),
	};
}

/** Profile one native audit of `workspace` (see the module docblock). */
export async function profileAudit(workspace: string): Promise<AuditProfile> {
	const root = resolve(workspace);
	const started = performance.now();
	const samples: MemorySample[] = [];
	const counts = { files: 0, functions: 0 };
	let topObjectTypes: { type: string; count: number }[] = [];
	const sample = (point: string): void => {
		samples.push({
			point,
			elapsedMs: Math.round(performance.now() - started),
			heapMiB: round(retainedHeapMiB()),
			rssMiB: round(process.memoryUsage().rss / MIB),
		});
	};
	sample("start");
	const holder: { report: unknown } = {
		report: await auditWorkspace(root, {
			onProgress: (event) => {
				if (event.type === "syntax-built") {
					counts.files = event.files;
					counts.functions = event.functions;
				}
				sample(eventPoint(event));
				if (event.type === "measured") topObjectTypes = topTypes();
			},
		}),
	};
	// Measure on a fresh macrotask: JSC scans the stack conservatively, and the
	// audit's just-finished frames would otherwise pin the released AST.
	await new Promise((done) => setTimeout(done, 0));
	sample("report-assembled");
	const cost = measureReport(holder);
	return {
		workspace: root,
		...counts,
		samples,
		peakRssMiB: round(Math.max(peakRssMiB(), ...samples.map((s) => s.rssMiB))),
		...cost,
		topObjectTypes,
	};
}

/** The ten most numerous live object types (deterministic tie-break by name). */
function topTypes(): { type: string; count: number }[] {
	return Object.entries(heapStats().objectTypeCounts)
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1))
		.slice(0, 10);
}

/** Markdown summary of a profile. */
export function renderProfile(profile: AuditProfile): string {
	const lines = [
		`# audit memory profile — ${profile.workspace}`,
		"",
		`${profile.files} files · ${profile.functions} functions · peak RSS ${profile.peakRssMiB} MiB`,
		"",
		"| point | elapsed ms | retained heap MiB | RSS MiB |",
		"|---|---|---|---|",
		...profile.samples.map((s) => `| ${s.point} | ${s.elapsedMs} | ${s.heapMiB} | ${s.rssMiB} |`),
		"",
		`report retained ${profile.reportHeapMiB} MiB · zod copy ${profile.schemaCopyHeapMiB} MiB (${profile.schemaParseMs} ms)`,
		`JSON compact ${profile.compactJsonMiB} MiB (${profile.compactJsonMs} ms) · pretty ${profile.prettyJsonMiB} MiB (${profile.prettyJsonMs} ms)`,
	];
	return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const workspace = args.find((arg) => !arg.startsWith("--"));
	const outIndex = args.indexOf("--out");
	if (workspace === undefined) {
		process.stderr.write("usage: bun run scripts/profile-audit.ts <workspace> [--out file]\n");
		process.exit(1);
	}
	const profile = await profileAudit(workspace);
	process.stdout.write(renderProfile(profile));
	const out = outIndex === -1 ? undefined : args[outIndex + 1];
	if (out !== undefined) writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
}
