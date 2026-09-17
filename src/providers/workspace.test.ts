import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSourceInventory } from "../discovery/index.ts";
import type { StagedSelectionFile, StagingRequest } from "./staging.ts";
import { containsPath, StagingError, sha256Hex } from "./staging.ts";
import { stageWorkspaceView } from "./workspace.ts";

const IS_POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

/** Selection entry fields shared by hand-built selections. */
const entryBase = { sourceSet: "production", packagePath: "." } as const;

/** Fresh empty target workspace (a real temp dir, no Git, no dependencies). */
async function makeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "trellis-stage-target-"));
}

/** Discovery-based selection: the realistic projection adapters will pass. */
async function discoverSelection(root: string): Promise<StagedSelectionFile[]> {
	const inventory = await discoverSourceInventory(root);
	return inventory.files.map((file) => ({
		path: file.path,
		sourceSet: file.sourceSet,
		packagePath: file.packagePath,
	}));
}

function stagedRequest(root: string, files: readonly StagedSelectionFile[]): StagingRequest {
	return { root, files };
}

/** Every repo-relative file path under `dir`, POSIX-style. */
async function listFiles(dir: string): Promise<string[]> {
	const paths: string[] = [];
	const walk = async (abs: string, rel: string): Promise<void> => {
		for (const entry of await readdir(abs, { withFileTypes: true })) {
			const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) await walk(join(abs, entry.name), entryRel);
			else paths.push(entryRel);
		}
	};
	await walk(dir, "");
	return paths.sort();
}

/** Count leftover trellis-owned scratch dirs in the system tmpdir. */
async function scratchLeakCount(): Promise<number> {
	const names = await readdir(tmpdir());
	return names.filter((name) => name.startsWith("trellis-staged-")).length;
}

describe("stageWorkspaceView", () => {
	test("stages a classified source-only snapshot of a non-Git, no-dependency workspace", async () => {
		const root = await makeRoot();
		try {
			await mkdir(join(root, "src"), { recursive: true });
			await writeFile(join(root, "src/a.ts"), "const a = 1;\n");
			await writeFile(join(root, "src/a.test.ts"), "test a;\n");
			await mkdir(join(root, "generated"), { recursive: true });
			await writeFile(join(root, "generated/g.ts"), "gen\n");
			await mkdir(join(root, "vendor"), { recursive: true });
			await writeFile(join(root, "vendor/v.ts"), "vend\n");
			await writeFile(join(root, "types.d.ts"), "declare\n");
			await mkdir(join(root, "pkg"), { recursive: true });
			await writeFile(join(root, "pkg/package.json"), '{"name":"pkg"}');
			await writeFile(join(root, "pkg/b.ts"), "const b = 2;\n");

			const view = await stageWorkspaceView({
				root,
				files: await discoverSelection(root),
			});
			try {
				expect(existsSync(join(root, ".git"))).toBe(false);
				expect(view.root).toBe(realpathSync(root));
				expect(view.provenance.mode).toBe("source-only");
				expect(view.files.map((file) => file.path)).toEqual([
					"generated/g.ts",
					"pkg/b.ts",
					"src/a.test.ts",
					"src/a.ts",
					"types.d.ts",
					"vendor/v.ts",
				]);
				const byPath = new Map(view.files.map((file) => [file.path, file]));
				expect(byPath.get("src/a.test.ts")?.sourceSet).toBe("test");
				expect(byPath.get("generated/g.ts")?.sourceSet).toBe("generated");
				expect(byPath.get("vendor/v.ts")?.sourceSet).toBe("vendored");
				expect(byPath.get("types.d.ts")?.sourceSet).toBe("declaration-only");
				expect(byPath.get("pkg/b.ts")?.packagePath).toBe("pkg");
				expect(byPath.get("pkg/b.ts")?.sha256).toBe(sha256Hex("const b = 2;\n"));
				expect(byPath.get("pkg/b.ts")?.bytes).toBe(13);
				expect(await readFile(byPath.get("pkg/b.ts")?.stagedPath ?? "", "utf8")).toBe(
					"const b = 2;\n",
				);
				expect(view.provenance.filesBySourceSet).toEqual({
					production: 2,
					test: 1,
					generated: 1,
					vendored: 1,
					"declaration-only": 1,
				});
				expect(view.contextFiles).toEqual([]);
				expect(view.readFailures).toEqual([]);
				expect(view.rejected).toEqual([]);
				expect(containsPath(view.root, view.scratchDir)).toBe(false);
				expect(containsPath(view.scratchDir, view.stagedRoot)).toBe(true);
				expect(containsPath(view.scratchDir, view.workDir)).toBe(true);
				expect(existsSync(view.workDir)).toBe(true);
				expect(await listFiles(view.stagedRoot)).toEqual(view.files.map((file) => file.path));
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reports unreadable selections explicitly and stages the rest", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "A\n");
			const view = await stageWorkspaceView(
				stagedRequest(root, [
					{ path: "a.ts", ...entryBase },
					{ path: "missing.ts", ...entryBase },
				]),
			);
			try {
				expect(view.files.map((file) => file.path)).toEqual(["a.ts"]);
				expect(view.readFailures).toEqual([
					{ path: "missing.ts", reason: expect.stringContaining("could not be resolved") },
				]);
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!IS_POSIX || IS_ROOT)(
		"reports permission-denied reads as read failures",
		async () => {
			const root = await makeRoot();
			try {
				await writeFile(join(root, "locked.ts"), "secret-ish\n");
				await chmod(join(root, "locked.ts"), 0o000);
				const view = await stageWorkspaceView(
					stagedRequest(root, [{ path: "locked.ts", ...entryBase }]),
				);
				try {
					expect(view.files).toEqual([]);
					expect(view.readFailures).toEqual([
						{
							path: "locked.ts",
							reason: expect.stringMatching(/could not be (read|resolved).*EACCES/),
						},
					]);
				} finally {
					await view.cleanup();
					await chmod(join(root, "locked.ts"), 0o644);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test("rejects symlink and traversal escapes without staging undisclosed files", async () => {
		const root = await makeRoot();
		const outside = await mkdtemp(join(tmpdir(), "trellis-stage-outside-"));
		try {
			const secret = "undisclosed secret payload\n";
			await writeFile(join(outside, "secret.ts"), secret);
			await mkdir(join(outside, "hidden-pkg"), { recursive: true });
			await writeFile(join(outside, "hidden-pkg/x.ts"), "hidden\n");
			await writeFile(join(root, "in-root.ts"), "fine\n");
			symlinkSync(join(outside, "secret.ts"), join(root, "file-link.ts"));
			symlinkSync(join(outside, "hidden-pkg"), join(root, "dir-link"));

			const view = await stageWorkspaceView(
				stagedRequest(root, [
					{ path: "in-root.ts", ...entryBase },
					{ path: "file-link.ts", ...entryBase },
					{ path: "dir-link/x.ts", ...entryBase },
				]),
			);
			try {
				expect(view.files.map((file) => file.path)).toEqual(["in-root.ts"]);
				expect(view.rejected.map((entry) => entry.path)).toEqual(["dir-link/x.ts", "file-link.ts"]);
				expect(view.rejected[0]?.reason).toContain("outside the audited root");
				// Nothing from outside the audited root ever crossed into scratch.
				for (const path of await listFiles(view.scratchDir)) {
					const staged = await readFile(join(view.scratchDir, path), "utf8").catch(() => "");
					expect(staged.includes("undisclosed secret payload")).toBe(false);
				}
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("follows symlinked files that resolve inside the audited root", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "real.ts"), "shared bytes\n");
			symlinkSync(join(root, "real.ts"), join(root, "link.ts"));
			const view = await stageWorkspaceView(
				stagedRequest(root, [
					{ path: "real.ts", ...entryBase },
					{ path: "link.ts", ...entryBase },
				]),
			);
			try {
				expect(view.files).toHaveLength(2);
				expect(view.files.every((file) => file.sha256 === sha256Hex("shared bytes\n"))).toBe(true);
				// Staged copies are plain files — no symlink crosses into scratch.
				expect(existsSync(join(view.stagedRoot, "link.ts"))).toBe(true);
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("canonicalizes aliased roots and exposes canonical scratch paths", async () => {
		const root = await makeRoot();
		const aliasHolder = await mkdtemp(join(tmpdir(), "trellis-stage-alias-"));
		try {
			await writeFile(join(root, "a.ts"), "A\n");
			symlinkSync(root, join(aliasHolder, "alias"));
			const view = await stageWorkspaceView(
				stagedRequest(join(aliasHolder, "alias"), [{ path: "a.ts", ...entryBase }]),
			);
			try {
				expect(view.root).toBe(realpathSync(root));
				expect(view.root.includes("alias")).toBe(false);
				expect(view.scratchDir).toBe(realpathSync(view.scratchDir));
				expect(view.files).toHaveLength(1);
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(aliasHolder, { recursive: true, force: true });
		}
	});

	test("preserves spaces and unicode in staged paths", async () => {
		const root = await makeRoot();
		try {
			const spaced = "dir with spaces/a file.ts";
			const unicode = "ünïcode/çøde ünï.ts";
			await mkdir(join(root, dirname(spaced)), { recursive: true });
			await mkdir(join(root, dirname(unicode)), { recursive: true });
			await writeFile(join(root, spaced), "spaced\n");
			await writeFile(join(root, unicode), "unicode\n");
			const view = await stageWorkspaceView(
				stagedRequest(root, [
					{ path: spaced, ...entryBase },
					{ path: unicode, ...entryBase },
				]),
			);
			try {
				expect(view.files.map((file) => file.path)).toEqual([spaced, unicode].sort());
				expect(await readFile(join(view.stagedRoot, spaced), "utf8")).toBe("spaced\n");
				expect(await readFile(join(view.stagedRoot, unicode), "utf8")).toBe("unicode\n");
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("computes deterministic digests over bytes and classification", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "same\n");
			await writeFile(join(root, "b.ts"), "same\n");
			const production = await discoverSelection(root);
			const asTest: StagedSelectionFile[] = production.map((file) => ({
				...file,
				sourceSet: "test",
			}));
			const base = await stageWorkspaceView(stagedRequest(root, production));
			const repeat = await stageWorkspaceView(stagedRequest(root, production));
			const reclassified = await stageWorkspaceView(stagedRequest(root, asTest));
			try {
				expect(repeat.provenance.snapshotDigest).toBe(base.provenance.snapshotDigest);
				expect(reclassified.provenance.snapshotDigest).not.toBe(base.provenance.snapshotDigest);
			} finally {
				await base.cleanup();
				await repeat.cleanup();
				await reclassified.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses to stage when the temp directory resolves inside the audited root", async () => {
		const before = await scratchLeakCount();
		const root = dirname(realpathSync(tmpdir()));
		await expect(stageWorkspaceView(stagedRequest(root, []))).rejects.toThrow(
			/inside the audited root/,
		);
		// The refused staging cleaned up its already-created scratch.
		expect(await scratchLeakCount()).toBe(before);
	});

	test("fails closed with scratch cleanup when the view cannot be prepared", async () => {
		const before = await scratchLeakCount();
		const root = await makeRoot();
		try {
			await writeFile(join(root, "plain.ts"), "A\n");
			const fine = await stageWorkspaceView(
				stagedRequest(root, [{ path: "plain.ts", ...entryBase }]),
			);
			await fine.cleanup();
			await expect(
				stageWorkspaceView(stagedRequest("/nonexistent/trellis/nowhere", [])),
			).rejects.toThrow(StagingError);
			await expect(
				stageWorkspaceView(stagedRequest("/nonexistent/trellis/nowhere", [])),
			).rejects.toThrow(/could not resolve audited root/);
			const fileRoot = join(root, "not-a-dir");
			await writeFile(fileRoot, "file\n");
			await expect(stageWorkspaceView(stagedRequest(fileRoot, []))).rejects.toThrow(
				/is not a directory/,
			);
			// A scratch that cannot be created at all is an operational error.
			const savedTmpdir = process.env.TMPDIR;
			process.env.TMPDIR = "/nonexistent/trellis/scratch-parent";
			try {
				await expect(stageWorkspaceView(stagedRequest(root, []))).rejects.toThrow(StagingError);
			} finally {
				if (savedTmpdir === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = savedTmpdir;
			}
			expect(await scratchLeakCount()).toBe(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
