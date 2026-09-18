import { describe, expect, test } from "bun:test";
import { findingSchema } from "./finding.ts";
import { type HotspotIdentity, hotspotIdentitySchema } from "./hotspot-identity.ts";
import { fixtureEvidenceArea } from "./report.fixtures.ts";
import { auditReportSchema } from "./report.ts";

const FINDING = {
	kind: "complexity.hotspot",
	path: "src/a.ts",
	range: { start: { line: 1 }, end: { line: 5 } },
	summary: "CC 23",
};
const IDENTITY: HotspotIdentity = {
	version: "1.0.0",
	state: "identified",
	sourceSet: "production",
	scopes: [{ kind: "class", name: "A", member: "none" }],
	function: { kind: "method", name: "run", member: "instance" },
};

describe("hotspotIdentitySchema", () => {
	test("preserves structured identity and explicit ambiguity without fabricating historical identity", () => {
		for (const identity of [
			IDENTITY,
			{ version: "1.0.0", state: "ambiguous", reason: "anonymous" },
		]) {
			const finding = { ...FINDING, identity };
			expect(findingSchema.parse(JSON.parse(JSON.stringify(finding)))).toEqual<unknown>(finding);
		}
		expect(findingSchema.parse(FINDING)).not.toHaveProperty("identity");
	});

	test("rejects malformed identities and use on other finding kinds", () => {
		for (const identity of [
			{ ...IDENTITY, version: "2.0.0" },
			{ ...IDENTITY, state: "legacy" },
			{ ...IDENTITY, sourceSet: "unknown" },
			{ ...IDENTITY, scopes: [{ kind: "block", name: "1", member: "none" }] },
			{ ...IDENTITY, function: { kind: "method", name: "", member: "instance" } },
			{ ...IDENTITY, line: 1 },
			{ version: "1.0.0", state: "ambiguous", reason: "unknown" },
			{ version: "1.0.0", state: "ambiguous", reason: "duplicate", function: IDENTITY.function },
		]) {
			expect(hotspotIdentitySchema.safeParse(identity).success).toBe(false);
			expect(findingSchema.safeParse({ ...FINDING, identity }).success).toBe(false);
		}
		expect(
			findingSchema.safeParse({ ...FINDING, kind: "import-cycle", identity: IDENTITY }).success,
		).toBe(false);
	});

	test("reads historical report versions without accepting or inventing identity", () => {
		for (const schemaVersion of ["1.0.0", "1.1.0"]) {
			const report = {
				schemaVersion,
				analyzerVersion: "0.2.1",
				scoringVersion: "0.2.0-provisional",
				repo: { root: "/tmp/workspace" },
				sourceCoverage: { production: { files: 1 }, test: { files: 0 } },
				completeness: "complete",
				metrics: {
					"complexity.count": {
						id: "complexity.count",
						state: "complete",
						value: 1,
						unit: "count",
					},
				},
				score: { index: 0, direction: "lower-is-better", partial: false, contributions: [] },
				findings: [FINDING],
				safeguards: [],
				...(schemaVersion === "1.1.0"
					? { evidence: fixtureEvidenceArea(["complexity.count"]) }
					: {}),
			};
			expect(auditReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual<unknown>(report);
			expect(
				auditReportSchema.safeParse({
					...report,
					findings: [{ ...FINDING, identity: IDENTITY }],
				}).success,
			).toBe(false);
		}
	});
});
