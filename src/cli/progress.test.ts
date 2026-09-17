import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "./progress.ts";

/**
 * The CLI progress reporter for the deterministic audit core's bounded events
 * (SPEC §12, trellis-9a88). A non-verbose TTY rewrites a single status line in
 * place (`\r`) tracking the current phase + analyzer progress; `--verbose`
 * switches to a durable line-per-event log (any stream) with per-analyzer
 * detail; `--quiet` (and a non-verbose non-TTY) stays silent. A captured
 * `write` sink keeps these tests stream-free.
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
		expect(lines[0]).toContain("discovering sources");
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
		reporter?.onProgress({ type: "analyzer", id: "duplication", index: 1, total: 4 });
		reporter?.finish();
		const text = lines.join("");
		expect(text).toContain("[2/4] duplication");
		expect(text).not.toContain("\r");
	});

	test("--verbose forces rendering even on a non-TTY run and shows phase lines", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		expect(reporter).toBeDefined();
		reporter?.onProgress({ type: "phase", phase: "measure" });
		expect(lines.join("")).toContain("measuring");
	});

	test("--verbose labels every pipeline phase", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		for (const phase of [
			"configure",
			"discover",
			"parse",
			"measure",
			"safeguards",
			"score",
			"assemble",
		] as const) {
			reporter?.onProgress({ type: "phase", phase });
		}
		const text = lines.join("");
		for (const label of [
			"loading configuration",
			"discovering sources",
			"parsing",
			"measuring",
			"inspecting safeguards",
			"scoring",
			"assembling report",
		]) {
			expect(text).toContain(label);
		}
	});

	test("--verbose narrates the pipeline milestones", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		reporter?.onProgress({
			type: "source-discovered",
			files: 3,
			packages: 1,
			excluded: 0,
			unsupported: 0,
		});
		reporter?.onProgress({ type: "syntax-built", files: 3, functions: 7, diagnostics: 0 });
		reporter?.onProgress({ type: "measured", metrics: 20, findings: 2 });
		reporter?.onProgress({ type: "safeguards-inspected", results: 4, findings: 0 });
		reporter?.onProgress({ type: "scored", index: 12, partial: false });
		const text = lines.join("");
		expect(text).toContain("discovered 3 file(s) in 1 package(s)");
		expect(text).toContain("parsed 3 file(s) · 7 function(s)");
		expect(text).toContain("measured 20 metric(s) · 2 finding(s)");
		expect(text).toContain("inspected 4 safeguard(s)");
		expect(text).toContain("sloppiness index 12/100");
	});
});
