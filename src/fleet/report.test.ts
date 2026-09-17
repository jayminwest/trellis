import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditFixture } from "../report/audit-fixtures.ts";
import type { FleetEntry, FleetReport } from "./orchestrate.ts";
import { renderFleetMarkdown, renderFleetTerminal } from "./report.ts";

/** A fixed aggregate report exercising every entry shape: scored, policy-failed, drift-error, error. */
let REPORT: FleetReport;

/** A scored entry over the fixture report, with overridable policy/drift/delta. */
function okEntry(
	id: string,
	report: Awaited<ReturnType<typeof auditFixture>>["report"],
	over: Partial<Extract<FleetEntry, { ok: true }>> = {},
): FleetEntry {
	return {
		id,
		path: `/abs/${id}`,
		ok: true,
		report,
		policy: { failed: false, results: [] },
		drift: { match: 6, "allowed-delta": 1, drift: 0, missing: 0, extra: 0 },
		driftError: null,
		previousIndex: null,
		indexDelta: null,
		...over,
	};
}

describe("fleet renderers", () => {
	let clean: Awaited<ReturnType<typeof auditFixture>>;
	let sloppy: Awaited<ReturnType<typeof auditFixture>>;

	beforeEach(async () => {
		clean = await auditFixture("clean");
		sloppy = await auditFixture("sloppy");
		REPORT = {
			auditedAt: "2026-06-06T00:00:00.000Z",
			entries: [
				okEntry("warren", clean.report, { previousIndex: 4, indexDelta: -4 }),
				okEntry("trellis", sloppy.report, {
					policy: {
						failed: true,
						results: [
							{
								policy: "max-index",
								status: "fail",
								reasons: [{ code: "index-exceeds-max", message: "index exceeds max 0" }],
							},
						],
					},
					drift: { match: 3, "allowed-delta": 0, drift: 2, missing: 1, extra: 0 },
				}),
				okEntry("drifty", clean.report, {
					drift: null,
					driftError: "canonical version 9.9.9 is not bundled (have 1.0.0)",
				}),
				{ id: "gone", path: "/abs/gone", ok: false, error: "path not found or not a directory" },
			],
			summary: { ok: 3, error: 1, policyFailed: 1 },
		};
	});

	afterEach(async () => {
		await clean.cleanup();
		await sloppy.cleanup();
	});

	describe("renderFleetTerminal", () => {
		test("renders the aggregate dashboard", () => {
			expect(renderFleetTerminal(REPORT)).toMatchSnapshot();
		});

		test("marks the index, policy failure, drift counts, delta, and errors inline", () => {
			const out = renderFleetTerminal(REPORT);
			expect(out).toContain("trellis fleet");
			expect(out).toContain("lower is better");
			expect(out).toContain(`${clean.report.score.index}/100`);
			expect(out).toContain("FAIL"); // tripped declarative policy
			expect(out).toContain("drift 2 · miss 1");
			expect(out).toContain("-4"); // improved vs previous run
			expect(out).toContain("new"); // first run, no prior index
			expect(out).toContain("error: path not found or not a directory");
			expect(out).toContain("drift error: canonical version 9.9.9 is not bundled");
			expect(out).toContain("3 ok · 1 error · 1 policy failed");
		});
	});

	describe("renderFleetMarkdown", () => {
		test("renders a PR/issue-ready table", () => {
			expect(renderFleetMarkdown(REPORT)).toMatchSnapshot();
		});

		test("keeps one row per target and carries the direction note", () => {
			const out = renderFleetMarkdown(REPORT);
			const rows = out.split("\n").filter((l) => l.startsWith("| `"));
			expect(rows).toHaveLength(4);
			expect(out).toContain("**lower is better**");
			expect(out).toContain(`| \`warren\` | ${clean.report.score.index}/100 | complete |`);
		});
	});
});
