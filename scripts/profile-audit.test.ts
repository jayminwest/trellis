import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileAudit, renderProfile } from "./profile-audit.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-profile-audit-"));
	await mkdir(join(repo, "src"), { recursive: true });
	await writeFile(join(repo, "package.json"), '{ "name": "profile-fixture" }\n');
	await writeFile(
		join(repo, "src/a.ts"),
		"export function a(x: number) {\n\tif (x > 1) return x;\n\treturn 0;\n}\n",
	);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("profileAudit", () => {
	test("samples every phase boundary and sizes the report", async () => {
		const profile = await profileAudit(repo);
		expect(profile.files).toBe(1);
		expect(profile.functions).toBe(1);
		const points = profile.samples.map((sample) => sample.point);
		expect(points[0]).toBe("start");
		expect(points).toContain("syntax-built");
		expect(points).toContain("analyzer:duplication");
		expect(points.at(-1)).toBe("report-assembled");
		expect(profile.peakRssMiB).toBeGreaterThan(0);
		expect(profile.compactJsonMiB).toBeLessThanOrEqual(profile.prettyJsonMiB);
		expect(profile.topObjectTypes.length).toBeGreaterThan(0);
		const markdown = renderProfile(profile);
		expect(markdown).toContain("| syntax-built |");
		expect(markdown).toContain("1 files · 1 functions");
	}, 20_000);
});
