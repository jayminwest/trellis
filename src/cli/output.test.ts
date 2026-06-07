import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, formatForPath, type Rendered, writeReportFile } from "./output.ts";

/**
 * `--output` file export (SPEC §12): the file format is inferred from the path
 * extension, with `--json` / `--md` taking precedence; an unknown extension
 * falls back to the human terminal text. Writing routes through a {@link CliError}
 * on I/O failure so the top-level handler renders it consistently.
 */

const RENDERED: Rendered = { human: "HUMAN", json: { value: 1 }, md: "# MD" };

describe("formatForPath", () => {
	test("infers json/markdown from the extension when no flag is set", () => {
		expect(formatForPath("report.json", "human")).toBe("json");
		expect(formatForPath("report.md", "human")).toBe("md");
	});

	test("an explicit --json/--md format overrides the extension", () => {
		expect(formatForPath("report.md", "json")).toBe("json");
		expect(formatForPath("report.json", "md")).toBe("md");
	});

	test("an unknown extension falls back to the human terminal text", () => {
		expect(formatForPath("report.txt", "human")).toBe("human");
	});
});

describe("writeReportFile", () => {
	test("writes the inferred format's content with a single trailing newline", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-output-"));
		try {
			const path = join(dir, "report.json");
			writeReportFile(path, formatForPath(path, "human"), RENDERED);
			expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(RENDERED.json, null, 2)}\n`);

			const md = join(dir, "report.md");
			writeReportFile(md, formatForPath(md, "human"), RENDERED);
			expect(readFileSync(md, "utf8")).toBe("# MD\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unwritable path raises a CliError rather than a raw throw", () => {
		const path = join(tmpdir(), "trellis-no-such-dir", "nested", "report.json");
		expect(() => writeReportFile(path, "json", RENDERED)).toThrow(CliError);
	});
});
