import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	byRelativePath,
	computeSnapshotDigest,
	containsPath,
	InvalidStagingRequestError,
	makeCleanup,
	makeDetectDrift,
	messageOf,
	normalizeStagingRequest,
	type StagedContextFile,
	type StagedFile,
	type StagingRequest,
	sha256Hex,
} from "./staging.ts";

const IS_POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

const OK_ENTRY = { path: "a.ts", sourceSet: "production", packagePath: "." } as const;

function request(overrides: Record<string, unknown> = {}): StagingRequest {
	return { root: "/tmp/workspace", files: [OK_ENTRY], ...overrides } as StagingRequest;
}

/** Assert that `value` is rejected with the staging request error. */
function rejectsBad(value: unknown): void {
	expect(() => normalizeStagingRequest(value as StagingRequest)).toThrow(
		InvalidStagingRequestError,
	);
}

describe("staging primitives", () => {
	test("fingerprints bytes with SHA-256 and reports non-Error throwables as strings", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
		expect(messageOf(new Error("boom"))).toBe("boom");
		expect(messageOf(42)).toBe("42");
	});

	test("containsPath compares canonical paths without .. false positives", () => {
		expect(containsPath("/a", "/a/b/c.ts")).toBe(true);
		expect(containsPath("/a", "/a")).toBe(false);
		expect(containsPath("/a", "/ab/c.ts")).toBe(false);
		expect(containsPath("/a", "/a/..hidden.ts")).toBe(true);
		expect(containsPath("/a", "/a/../c.ts")).toBe(false);
	});

	test("byRelativePath orders the root package first and paths lexicographically", () => {
		expect(["b", ".", "a"].sort(byRelativePath)).toEqual([".", "a", "b"]);
	});

	test("computeSnapshotDigest is order-independent and content-sensitive", () => {
		const a = { path: "a.ts", kind: "production", sha256: "aa" };
		const b = { path: "b.ts", kind: "test", sha256: "bb" };
		expect(computeSnapshotDigest([b, a])).toBe(computeSnapshotDigest([a, b]));
		expect(computeSnapshotDigest([{ ...a, sha256: "cc" }])).not.toBe(computeSnapshotDigest([a]));
	});
});

describe("normalizeStagingRequest", () => {
	test("normalizes a valid request with deterministic order and defaults", () => {
		const normalized = normalizeStagingRequest({
			root: "/tmp/workspace",
			files: [
				{ path: "pkg/b.ts", sourceSet: "test", packagePath: "pkg" },
				{ path: "a.ts", sourceSet: "production", packagePath: "pkg" },
			],
			mode: "project-aware",
		});
		expect(normalized).toEqual({
			root: "/tmp/workspace",
			files: [
				{ path: "a.ts", sourceSet: "production", packagePath: "pkg" },
				{ path: "pkg/b.ts", sourceSet: "test", packagePath: "pkg" },
			],
			// Default package roots: the selection's owners plus the root.
			packageRoots: [".", "pkg"],
			mode: "project-aware",
		});
	});

	test("defaults to source-only mode", () => {
		expect(normalizeStagingRequest(request()).mode).toBe("source-only");
	});

	test("collapses duplicate selections, first occurrence winning", () => {
		const normalized = normalizeStagingRequest(
			request({
				files: [
					{ path: "a.ts", sourceSet: "test", packagePath: "." },
					{ path: "a.ts", sourceSet: "production", packagePath: "." },
				],
			}),
		);
		expect(normalized.files).toEqual([{ path: "a.ts", sourceSet: "test", packagePath: "." }]);
	});

	test("rejects malformed requests", () => {
		rejectsBad(null);
		rejectsBad({ files: [] });
		rejectsBad({ root: "", files: [] });
		rejectsBad({ root: "/a\u0000b", files: [] });
		rejectsBad({ root: "/tmp", files: [], mode: "full" });
		rejectsBad({ root: "/tmp", files: "nope" });
		rejectsBad({ root: "/tmp", files: [null] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, path: "/abs.ts" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, path: "../esc.ts" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, path: "a\\b.ts" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, path: "." }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, path: "a\u0000.ts" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, sourceSet: "bonus" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, packagePath: "/abs" }] });
		rejectsBad({ root: "/tmp", files: [{ ...OK_ENTRY, packagePath: "p\u0000" }] });
		rejectsBad({ root: "/tmp", files: [], packageRoots: "nope" });
		rejectsBad({ root: "/tmp", files: [], packageRoots: [".."] });
	});

	test("de-duplicates and orders explicit package roots", () => {
		const normalized = normalizeStagingRequest(request({ packageRoots: ["b", ".", "a", "b"] }));
		expect(normalized.packageRoots).toEqual([".", "a", "b"]);
	});
});

describe("makeDetectDrift", () => {
	test("reports changed and unreadable target files against the snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-drift-"));
		try {
			await writeFile(join(root, "a.ts"), "original\n");
			await writeFile(join(root, "b.ts"), "stable\n");
			const snapshot = [
				...makeSnapshot(["a.ts"], "original\n"),
				...makeSnapshot(["b.ts"], "stable\n"),
			];
			const detectDrift = makeDetectDrift(root, snapshot, []);
			expect((await detectDrift()).entries).toEqual([]);

			await writeFile(join(root, "a.ts"), "edited\n");
			await rm(join(root, "b.ts"));
			expect(await detectDrift()).toEqual({
				entries: [
					{
						path: "a.ts",
						kind: "changed",
						snapshotSha256: sha256Hex("original\n"),
						currentSha256: sha256Hex("edited\n"),
					},
					{ path: "b.ts", kind: "unreadable", reason: expect.stringContaining("ENOENT") },
				],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("checks staged context files alongside source files", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-drift-ctx-"));
		try {
			await writeFile(join(root, "package.json"), '{"name":"pkg"}\n');
			await writeFile(join(root, "a.ts"), "A\n");
			const source = makeSnapshot(["a.ts"], "A\n");
			const context: StagedContextFile[] = [
				{
					path: "package.json",
					stagedPath: "/unused",
					role: "manifest",
					sha256: sha256Hex('{"name":"pkg"}\n'),
					bytes: 15,
				},
			];
			expect((await makeDetectDrift(root, source, context)()).entries).toEqual([]);
			await writeFile(join(root, "package.json"), '{"name":"other"}\n');
			const drift = await makeDetectDrift(root, source, context)();
			expect(drift.entries.map((entry) => entry.path)).toEqual(["package.json"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("makeCleanup", () => {
	test("removes the owned scratch and reports idempotent repeats", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-clean-"));
		await writeFile(join(dir, "occupied"), "blocker\n");
		const cleanup = makeCleanup(dir);
		expect(await cleanup()).toEqual({ status: "cleaned" });
		expect(existsSync(dir)).toBe(false);
		expect(await cleanup()).toEqual({ status: "already-clean" });
	});

	test.skipIf(!IS_POSIX || IS_ROOT)(
		"reports cleanup failure without hiding it, and a retry can succeed",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "trellis-clean-fail-"));
			await writeFile(join(dir, "occupied"), "blocker\n");
			await chmod(dir, 0o500);
			try {
				const failed = await makeCleanup(dir)();
				expect(failed.status).toBe("failed");
			} finally {
				await chmod(dir, 0o700);
			}
			const cleanup = makeCleanup(dir);
			expect(await cleanup()).toEqual({ status: "cleaned" });
			expect(existsSync(dir)).toBe(false);
		},
	);
});

/** Hand-built snapshot records: only path and fingerprint matter for drift. */
function makeSnapshot(paths: string[], content: string): StagedFile[] {
	return paths.map((path) => ({
		path,
		stagedPath: join("/unused", path),
		sourceSet: "production",
		packagePath: ".",
		sha256: sha256Hex(content),
		bytes: content.length,
	}));
}
