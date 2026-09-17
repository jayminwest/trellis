import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "./progress.ts";

/**
 * The CLI progress reporter for the deterministic audit pipeline (SPEC §4). A
 * non-verbose TTY rewrites a single status line in place (`\r`) tracking the
 * current phase + analyzer position; `--verbose` switches to a durable
 * line-per-event log (any stream) with per-analyzer detail; `--quiet` (and a
 * non-verbose non-TTY) stays silent. A captured `write` sink keeps these tests
 * stream-free.
 */

function capture(opts: { verbose?: boolean; quiet?: boolean; isTTY?: boolean }): {
	lines: string[];
	reporter: ReturnType<typeof createProgressReporter>;
} {
	const lines: string[] = [];
	const reporter = createProgressReporter({ ...opts, write: (line) => lines.push(line) });
	return { lines, reporter };
}

describe("createProgressReporter", () => {
	test("returns undefined when --quiet, even on a TTY", () => {
		expect(createProgressReporter({ quiet: true, isTTY: true })).toBeUndefined();
	});

	test("returns undefined for a non-TTY run without --verbose (no CI noise)", () => {
		expect(createProgressReporter({ isTTY: false })).toBeUndefined();
	});

	test("rewrites one in-place status line tracking phase + progress on a TTY", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.onProgress({ type: "phase", phase: "discover" });
		reporter?.onProgress({
			type: "source-discovered",
			files: 12,
			packages: 1,
			excluded: 0,
			unsupported: 0,
		});
		reporter?.onProgress({ type: "phase", phase: "measure" });
		reporter?.onProgress({ type: "analyzer", id: "complexity", index: 0, total: 4 });
		// Every line rewrites in place (\r) and clears to EOL, never a newline.
		for (const line of lines) {
			expect(line.startsWith("\r")).toBe(true);
			expect(line).not.toContain("\n");
		}
		expect(lines[1]).toContain("discovered 12 files");
		const last = lines.at(-1) ?? "";
		expect(last).toContain("measuring (1/4)");
	});

	test("finish clears the status line so the report prints clean", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.onProgress({ type: "phase", phase: "score" });
		reporter?.finish();
		expect(lines.at(-1)).toBe("\r\x1b[K");
	});

	test("finish is a no-op before any event is rendered", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.finish();
		expect(lines).toHaveLength(0);
	});

	test("--verbose logs durable per-analyzer lines and finish does not clear", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: true });
		reporter?.onProgress({ type: "analyzer", id: "import-cycles", index: 3, total: 4 });
		reporter?.finish();
		const text = lines.join("");
		expect(text).toContain("[4/4] import-cycles");
		expect(text).not.toContain("\r");
	});

	test("--verbose forces rendering even on a non-TTY run and shows phase lines", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		expect(reporter).toBeDefined();
		reporter?.onProgress({ type: "phase", phase: "measure" });
		expect(lines.join("")).toContain("measuring");
	});

	test("--verbose renders the pipeline's data events", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		reporter?.onProgress({
			type: "source-discovered",
			files: 8,
			packages: 2,
			excluded: 3,
			unsupported: 1,
		});
		reporter?.onProgress({ type: "syntax-built", files: 8, functions: 42, diagnostics: 0 });
		reporter?.onProgress({ type: "measured", metrics: 12, findings: 5 });
		reporter?.onProgress({ type: "safeguards-inspected", results: 4, findings: 0 });
		reporter?.onProgress({ type: "scored", index: 17, partial: false });
		const text = lines.join("");
		expect(text).toContain("discovered 8 file(s) across 2 package(s) (3 excluded, 1 unsupported)");
		expect(text).toContain("parsed 8 files (42 functions)");
		expect(text).toContain("measured 12 metrics, 5 findings");
		expect(text).toContain("inspected 4 safeguards");
		expect(text).toContain("sloppiness index 17/100 (lower is better)");
	});

	test("non-verbose events other than phase changes stay off the status line", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.onProgress({ type: "phase", phase: "safeguards" });
		reporter?.onProgress({ type: "safeguards-inspected", results: 4, findings: 0 });
		const last = lines.at(-1) ?? "";
		expect(last).toContain("inspecting safeguards");
		expect(last).not.toContain("4 safeguards");
	});
});
