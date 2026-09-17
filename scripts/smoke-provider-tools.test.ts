import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	smokeProviderTools,
	verifyLockfilePin,
	verifyPinnedToolPin,
} from "./smoke-provider-tools.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("verifyPinnedToolPin", () => {
	test("accepts this repository's exact devDependency pin", () => {
		const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
		const pinned = verifyPinnedToolPin(packageJson);
		expect(pinned).toEqual([{ tool: "jscpd", pinnedVersion: "5.2.1" }]);
	});

	test("rejects a version range instead of an exact pin", () => {
		expect(() => verifyPinnedToolPin({ devDependencies: { jscpd: "^5.2.1" } })).toThrow(
			/exact devDependency/,
		);
	});

	test("rejects a missing devDependency pin", () => {
		expect(() => verifyPinnedToolPin({ devDependencies: {} })).toThrow(/exact devDependency/);
	});

	test("rejects a pinned tool that leaked into native runtime dependencies", () => {
		expect(() =>
			verifyPinnedToolPin({
				dependencies: { jscpd: "5.2.1" },
				devDependencies: { jscpd: "5.2.1" },
			}),
		).toThrow(/leaked into native runtime dependencies/);
	});
});

describe("verifyLockfilePin", () => {
	test("accepts the repository lockfile's exact pin", () => {
		expect(() =>
			verifyLockfilePin(readFileSync(join(REPO_ROOT, "bun.lock"), "utf8")),
		).not.toThrow();
	});

	test("rejects a lockfile without the exact pin", () => {
		expect(() => verifyLockfilePin('"jscpd": "^9.9.9"')).toThrow(/does not pin jscpd/);
	});
});

describe("smokeProviderTools", () => {
	test("resolves and invokes the pinned jscpd offline from the repository install", async () => {
		const result = await smokeProviderTools(REPO_ROOT);
		expect(result.pinned).toEqual([{ tool: "jscpd", pinnedVersion: "5.2.1" }]);
		expect(result.invoked.length).toBe(1);
		const invocation = result.invoked[0];
		expect(invocation?.providerId).toBe("jscpd");
		expect(invocation?.versionOutput).toBe("jscpd 5.2.1");
		expect(invocation?.platformKey.length ?? 0).toBeGreaterThan(0);
	}, 20_000);
});
