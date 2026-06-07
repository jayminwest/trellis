import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../report/index.ts";
import { createProgressReporter } from "./progress.ts";

/**
 * The CLI progress reporter (SPEC §7.3) renders core {@link AuditEvent}s to
 * plain stderr lines. Defaults are TTY-aware (`--quiet` always silent, a
 * non-TTY run silent unless `--verbose`); verbose mode adds per-detector and
 * per-session detail. A captured `write` sink keeps these tests stream-free.
 */

function capture(opts: { verbose?: boolean; quiet?: boolean; isTTY?: boolean }): {
	lines: string[];
	report: ((event: AuditEvent) => void) | undefined;
} {
	const lines: string[] = [];
	const report = createProgressReporter({ ...opts, write: (line) => lines.push(line) });
	return { lines, report };
}

describe("createProgressReporter", () => {
	test("returns undefined when --quiet, even on a TTY", () => {
		expect(createProgressReporter({ quiet: true, isTTY: true })).toBeUndefined();
	});

	test("returns undefined for a non-TTY run without --verbose (no CI noise)", () => {
		expect(createProgressReporter({ isTTY: false })).toBeUndefined();
	});

	test("renders phase + app + investigation lines on a TTY", () => {
		const { lines, report } = capture({ isTTY: true });
		report?.({ type: "phase", phase: "discovery" });
		report?.({ type: "apps-discovered", count: 3 });
		report?.({ type: "investigation", event: { type: "cache-hit", area: "documentation" } });
		report?.({
			type: "investigation",
			event: { type: "probe", ok: false, detail: "pi missing" },
		});
		const text = lines.join("");
		expect(text).toContain("discovering apps");
		expect(text).toContain("discovered 3 app(s)");
		expect(text).toContain("documentation: cache hit");
		expect(text).toContain("pi unavailable: pi missing");
	});

	test("suppresses per-detector lines unless --verbose", () => {
		const quiet = capture({ isTTY: true });
		quiet.report?.({ type: "detector", id: "L2-foo", index: 0, total: 90 });
		expect(quiet.lines).toHaveLength(0);

		const loud = capture({ verbose: true });
		loud.report?.({ type: "detector", id: "L2-foo", index: 0, total: 90 });
		expect(loud.lines.join("")).toContain("[1/90] L2-foo");
	});

	test("--verbose forces rendering even on a non-TTY run and shows session detail", () => {
		const { lines, report } = capture({ verbose: true, isTTY: false });
		expect(report).toBeDefined();
		report?.({
			type: "investigation",
			event: { type: "session", area: "test-layout", event: { type: "retry", attempt: 2 } },
		});
		expect(lines.join("")).toContain("test-layout: corrective retry 2");
	});
});
