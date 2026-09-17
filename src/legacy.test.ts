import { describe, expect, test } from "bun:test";
import { LegacyConfigError, legacyConfigMessage, rejectLegacyOptions } from "./legacy.ts";

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
