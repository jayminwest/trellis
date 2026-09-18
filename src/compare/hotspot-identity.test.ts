import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/audit.ts";
import type { Finding } from "../contract/index.ts";
import { compareReports } from "./compare.ts";
import { compareFindings } from "./diff.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trellis-identity-compare-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const BODY = Array.from({ length: 11 }, (_, index) => `if (n === ${index}) return ${index};`).join(
	"\n",
);
const fn = (name: string) => `function ${name}(n: number) {\n${BODY}\n}\n`;
const method = (name: string) => `class ${name} { run(n: number) {\n${BODY}\n} }\n`;
async function audit(source: string) {
	await writeFile(join(root, "a.ts"), source);
	return auditWorkspace(root);
}

function hotspot(name = "alpha", line = 1): Finding {
	return {
		kind: "complexity.hotspot",
		path: "a.ts",
		range: { start: { line }, end: { line: line + 15 } },
		summary: "CC 12",
		identity: {
			version: "1.0.0",
			state: "identified",
			sourceSet: "production",
			scopes: [],
			function: { kind: "function-declaration", name, member: "none" },
		},
	};
}

describe("scoped hotspot comparison", () => {
	const controls = [
		{
			name: "persists shifted alpha/beta",
			before: fn("alpha") + fn("beta"),
			after: `// shift\n${fn("alpha")}${fn("beta")}`,
			counts: [0, 0, 2],
			shift: 1,
		},
		{
			name: "reports only added gamma",
			before: fn("alpha") + fn("beta"),
			after: fn("alpha") + fn("beta") + fn("gamma"),
			counts: [1, 0, 2],
		},
		{
			name: "resolves alpha and introduces replacement beta",
			before: fn("alpha"),
			after: fn("beta"),
			counts: [1, 1, 0],
		},
		{
			name: "distinguishes B.run from existing A.run",
			before: method("A"),
			after: method("A") + method("B"),
			counts: [1, 0, 1],
		},
	] as const;
	for (const control of controls) {
		test(control.name, async () => {
			const baseline = await audit(control.before);
			const current = await audit(control.after);
			const comparison = compareReports(baseline, current);
			expect(comparison.compatibility.comparable).toBe(true);
			const findings = comparison.findings;
			if (findings === undefined) throw new Error("missing findings");
			const count = (list: readonly Finding[]) =>
				list.filter((finding) => finding.kind === "complexity.hotspot").length;
			expect([
				count(findings.new),
				count(findings.resolved),
				count(findings.persistent.map((pair) => pair.current)),
			]).toEqual([...control.counts]);
			if ("shift" in control) {
				expect(
					findings.persistent
						.filter((pair) => pair.current.kind === "complexity.hotspot")
						.map((pair) => pair.lineShift),
				).toEqual([1, 1]);
			}
			expect(compareReports(baseline, current)).toEqual(comparison);
		});
	}

	test("keeps a CC increase persistent with separate metric deltas", async () => {
		const baseline = await audit(fn("alpha"));
		const current = await audit(fn("alpha").replace(BODY, `${BODY}\nif (n > 20) return 21;`));
		const comparison = compareReports(baseline, current);
		expect(comparison.findings?.new).toHaveLength(0);
		expect(comparison.findings?.persistent).toHaveLength(1);
		expect(
			comparison.metrics?.find((metric) => metric.id === "complexity.cc.max.production")?.delta,
		).toBe(1);
	});

	test("keeps repeated anonymous callbacks new and resolved even in one-to-one groups", async () => {
		const report = await audit(`values.map((n) => {\n${BODY}\n});`);
		const findings = compareReports(report, report).findings;
		expect(findings?.persistent).toHaveLength(0);
		expect(findings?.new).toHaveLength(1);
		expect(findings?.resolved).toHaveLength(1);
	});

	test("preserves every duplicate-key occurrence instead of inheriting one baseline match", () => {
		for (const [beforeCount, afterCount] of [
			[1, 2],
			[2, 1],
			[2, 2],
			[0, 2],
		]) {
			const before = Array.from({ length: beforeCount ?? 0 }, (_, i) => hotspot("alpha", i + 1));
			const after = Array.from({ length: afterCount ?? 0 }, (_, i) => hotspot("alpha", i + 20));
			const result = compareFindings(before, after);
			expect(result.persistent).toHaveLength(0);
			expect(result.new).toEqual(after);
			expect(result.resolved).toEqual(before);
		}
	});

	test("retains historical fallback but never pairs mixed or unknown identity provenance", () => {
		const modern = hotspot();
		const { identity: _identity, ...legacy } = modern;
		expect(
			compareFindings([legacy], [{ ...legacy, range: { start: { line: 8 }, end: { line: 20 } } }])
				.persistent[0]?.lineShift,
		).toBe(7);
		const unknown = {
			...modern,
			identity: { ...modern.identity, version: "99.0.0" },
		} as unknown as Finding;
		for (const [before, after] of [
			[modern, legacy],
			[legacy, modern],
			[unknown, unknown],
		] as const) {
			const result = compareFindings([before], [after]);
			expect(result.persistent).toHaveLength(0);
			expect(result.new).toHaveLength(1);
			expect(result.resolved).toHaveLength(1);
		}
	});

	test("uses structured keys independent of object property order, source location and summary", () => {
		const before = hotspot("x|y");
		const after = hotspot("x|y", 20);
		after.summary = "changed CC";
		if (after.identity?.state !== "identified") throw new Error("missing identity");
		after.identity.function = { member: "none", name: "x|y", kind: "function-declaration" };
		expect(compareFindings([before], [after]).persistent).toHaveLength(1);
		expect(compareFindings([before], [{ ...after, path: "b.ts" }]).persistent).toHaveLength(0);
		expect(
			compareFindings([before], [{ ...after, identity: { ...after.identity, sourceSet: "test" } }])
				.persistent,
		).toHaveLength(0);
	});
});
