import { describe, expect, test } from "bun:test";
import {
	LegacyConfigError,
	legacyConfigMessage,
	rejectLegacyOptions,
	rejectRetiredAuditOptions,
	retiredAuditSurfaceMessage,
} from "./legacy.ts";

describe("legacyConfigMessage", () => {
	test("names the knob, the retired pass, and the remedy", () => {
		const message = legacyConfigMessage("--no-cache");
		expect(message).toContain("--no-cache");
		expect(message).toContain("investigation");
		expect(message).toContain("deterministic and offline");
		expect(message).toContain("Remove --no-cache");
	});
});

describe("rejectLegacyOptions", () => {
	test("accepts an options bag with no retired keys", () => {
		expect(() => rejectLegacyOptions({ persist: false, db: "x.db" })).not.toThrow();
		expect(() => rejectLegacyOptions({})).not.toThrow();
	});

	test("rejects each retired investigation key with an actionable message", () => {
		for (const key of ["noCache", "piBin", "investigation", "provider", "model"]) {
			let caught: unknown;
			try {
				rejectLegacyOptions({ [key]: "x" });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(LegacyConfigError);
			expect((caught as Error).message).toContain(`option '${key}'`);
			expect((caught as Error).message).toContain("no longer exists");
		}
	});

	test("rejects a retired key even when its value is undefined", () => {
		expect(() => rejectLegacyOptions({ piBin: undefined })).toThrow(LegacyConfigError);
	});
});

describe("retiredAuditSurfaceMessage", () => {
	test("names the knob, the pivot, and the replacements", () => {
		const message = retiredAuditSurfaceMessage("option 'failOn'");
		expect(message).toContain("option 'failOn'");
		expect(message).toContain("deterministic pivot");
		expect(message).toContain("trellis.yaml");
		expect(message).toContain("Remove option 'failOn'");
	});
});

describe("rejectRetiredAuditOptions", () => {
	test("accepts the deterministic audit's own options", () => {
		expect(() =>
			rejectRetiredAuditOptions({
				configPath: "trellis.yaml",
				baselinePath: "b.json",
				history: true,
			}),
		).not.toThrow();
		expect(() => rejectRetiredAuditOptions({})).not.toThrow();
	});

	test("rejects each retired readiness-audit key with an actionable message", () => {
		for (const key of [
			"rubric",
			"rubricVersion",
			"rubricDir",
			"canonical",
			"minLevel",
			"failOn",
			"persist",
			"repoId",
		]) {
			let caught: unknown;
			try {
				rejectRetiredAuditOptions({ [key]: "x" });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(LegacyConfigError);
			expect((caught as Error).message).toContain(`option '${key}'`);
			expect((caught as Error).message).toContain("deterministic pivot");
		}
	});

	test("also rejects the retired investigation keys", () => {
		expect(() => rejectRetiredAuditOptions({ noCache: true })).toThrow(/option 'noCache'/);
	});
});
