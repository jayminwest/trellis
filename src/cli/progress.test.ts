import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "./progress.ts";

/**
 * The CLI progress reporter (SPEC §7.3). A non-verbose TTY rewrites a single
 * status line in place (`\r`) tracking the current phase + progress; `--verbose`
 * switches to a durable line-per-event log (any stream) with per-detector and
 * per-session detail; `--quiet` (and a non-verbose non-TTY) stays silent. A
 * captured `write` sink keeps these tests stream-free.
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
		reporter?.onProgress({ type: "phase", phase: "discovery" });
		reporter?.onProgress({ type: "apps-discovered", count: 3 });
		reporter?.onProgress({ type: "phase", phase: "investigation" });
		reporter?.onProgress({
			type: "investigation",
			event: { type: "area-start", area: "documentation", index: 1, total: 4 },
		});
		reporter?.onProgress({
			type: "investigation",
			event: { type: "session", area: "documentation", event: { type: "message" } },
		});
		// Every line rewrites in place (\r) and clears to EOL, never a newline.
		for (const line of lines) {
			expect(line.startsWith("\r")).toBe(true);
			expect(line).not.toContain("\n");
		}
		expect(lines[1]).toContain("discovered 3 apps");
		const last = lines.at(-1) ?? "";
		expect(last).toContain("documentation (2/4)");
		expect(last).toContain("1 msg");
	});

	test("finish clears the status line so the report prints clean", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.onProgress({ type: "phase", phase: "scoring" });
		reporter?.finish();
		expect(lines.at(-1)).toBe("\r\x1b[K");
	});

	test("finish is a no-op before any event is rendered", () => {
		const { lines, reporter } = capture({ isTTY: true });
		reporter?.finish();
		expect(lines).toHaveLength(0);
	});

	test("--verbose logs durable per-detector lines and finish does not clear", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: true });
		reporter?.onProgress({ type: "detector", id: "L2-foo", index: 0, total: 90 });
		reporter?.finish();
		const text = lines.join("");
		expect(text).toContain("[1/90] L2-foo");
		expect(text).not.toContain("\r");
	});

	test("--verbose forces rendering even on a non-TTY run and shows session detail", () => {
		const { lines, reporter } = capture({ verbose: true, isTTY: false });
		expect(reporter).toBeDefined();
		reporter?.onProgress({
			type: "investigation",
			event: { type: "session", area: "test-layout", event: { type: "retry", attempt: 2 } },
		});
		expect(lines.join("")).toContain("test-layout: corrective retry 2");
	});
});
