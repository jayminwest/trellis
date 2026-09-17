import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentity } from "./index.ts";

describe("repoIdentity", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-identity-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("is stable across path spellings and symlinks of the same directory", () => {
		const base = repoIdentity(dir);
		expect(repoIdentity(join(dir, "."))).toBe(base);
		expect(repoIdentity(`${dir}/`)).toBe(base);

		const link = join(tmpdir(), `trellis-identity-link-${process.pid}`);
		symlinkSync(dir, link);
		try {
			expect(repoIdentity(link)).toBe(base);
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("unrelated directories with the same basename never collide", () => {
		const a = join(dir, "a", "proj");
		const b = join(dir, "b", "proj");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });

		const idA = repoIdentity(a);
		const idB = repoIdentity(b);
		expect(idA).not.toBe(idB);
		// The human-readable label stays the shared basename; the hash separates them.
		expect(idA.startsWith("proj#")).toBe(true);
		expect(idB.startsWith("proj#")).toBe(true);
	});

	test("the declared identity labels the identity while the path hash still distinguishes", () => {
		const plain = repoIdentity(dir);
		const named = repoIdentity(dir, "trellis");
		expect(named.startsWith("trellis#")).toBe(true);
		expect(named.slice("trellis#".length)).toBe(plain.slice(plain.indexOf("#") + 1));
	});

	test("a nonexistent path still derives a deterministic identity", () => {
		const missing = join(dir, "gone");
		expect(repoIdentity(missing)).toBe(repoIdentity(missing));
	});
});
