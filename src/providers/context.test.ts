import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceInventory } from "../discovery/index.ts";
import { DEPENDENCY_SECTIONS, enumerateProjectContext, type ProjectContext } from "./context.ts";
import { stageWorkspaceView } from "./workspace.ts";

/** Fresh empty target workspace (no Git, no dependencies installed). */
async function makeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "trellis-ctx-target-"));
}

async function writeManifest(
	root: string,
	pkg: string,
	content: string | Record<string, unknown>,
): Promise<void> {
	const rel = pkg === "." ? "package.json" : `${pkg}/package.json`;
	if (pkg !== ".") await mkdir(join(root, pkg), { recursive: true });
	await writeFile(join(root, rel), typeof content === "string" ? content : JSON.stringify(content));
}

describe("enumerateProjectContext", () => {
	test("collects dependency names per section, sorted and de-duplicated", async () => {
		const root = await makeRoot();
		try {
			await writeManifest(root, ".", {
				dependencies: { zod: "^4", typescript: "~6.0" },
				devDependencies: { knip: "^6", "@biomejs/biome": "^2" },
				peerDependencies: { bun: ">=1" },
				optionalDependencies: "not-a-section",
			});
			const context = await enumerateProjectContext(root, ["."]);
			expect(context.files.map((file) => file.path)).toEqual(["package.json"]);
			expect(context.readFailures).toEqual([]);
			expect(context.issues).toEqual([]);
			expect(context.dependencies).toEqual([
				{
					packagePath: ".",
					sections: {
						dependencies: ["typescript", "zod"],
						devDependencies: ["@biomejs/biome", "knip"],
						peerDependencies: ["bun"],
						optionalDependencies: [],
					},
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("collects declared entry roots from string fields and bin maps", async () => {
		const root = await makeRoot();
		try {
			await writeManifest(root, ".", {
				main: "./src/main.ts",
				module: "./src/main.ts",
				types: "./types.d.ts",
				typings: "./types.d.ts",
				bin: { trellis: "./src/cli/main.ts", extra: "./x.ts", invalid: 7 },
				someOtherField: { ignored: true },
			});
			const context = await enumerateProjectContext(root, ["."]);
			expect(context.entryRoots).toEqual([
				{
					packagePath: ".",
					entries: ["./src/cli/main.ts", "./src/main.ts", "./types.d.ts", "./x.ts"],
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("records malformed manifests as issues while keeping their bytes", async () => {
		const root = await makeRoot();
		try {
			await writeManifest(root, ".", "{ not json");
			await mkdir(join(root, "arr"), { recursive: true });
			await writeManifest(root, "arr", "[]");
			const context = await enumerateProjectContext(root, [".", "arr"]);
			expect(context.files.map((file) => file.path)).toEqual(["arr/package.json", "package.json"]);
			expect(context.files.every((file) => file.bytes.byteLength > 0)).toBe(true);
			expect(context.issues.map((issue) => issue.path)).toEqual([
				"arr/package.json",
				"package.json",
			]);
			expect(context.issues[0]?.reason).toContain("not an object");
			expect(context.issues[1]?.reason).toContain("not valid JSON");
			// No declarations can be interpreted from malformed manifests.
			expect(context.dependencies).toEqual([]);
			expect(context.entryRoots).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("records missing manifests and unlistable package directories as read failures", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "plain-file"), "not a package\n");
			await writeManifest(root, "real", { name: "real" });
			const context = await enumerateProjectContext(root, [".", "missing", "plain-file", "real"]);
			expect(context.files.map((file) => file.path)).toEqual(["real/package.json"]);
			expect(context.readFailures).toEqual([
				{ path: "missing", reason: expect.stringContaining("not listable") },
				{ path: "missing/package.json", reason: expect.stringContaining("ENOENT") },
				{ path: "package.json", reason: expect.stringContaining("ENOENT") },
				{ path: "plain-file", reason: expect.stringContaining("not listable") },
				{ path: "plain-file/package.json", reason: expect.stringContaining("ENOTDIR") },
			]);
			// Only the readable package contributes declarations.
			expect(context.dependencies.map((decl) => decl.packagePath)).toEqual(["real"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("enumerates only root-level tsconfig files of each package", async () => {
		const root = await makeRoot();
		try {
			await writeManifest(root, ".", { name: "root" });
			await writeFile(join(root, "tsconfig.json"), "{}");
			await writeFile(join(root, "tsconfig.build.json"), "{}");
			await writeFile(join(root, "tsconfig.json.bak"), "{}"); // not a tsconfig name
			await mkdir(join(root, "sub"), { recursive: true });
			await writeFile(join(root, "sub/tsconfig.json"), "{}"); // nested, not enumerated
			await mkdir(join(root, "pkg"), { recursive: true });
			await writeManifest(root, "pkg", { name: "pkg" });
			await writeFile(join(root, "pkg/tsconfig.node.json"), "{}");

			const context = await enumerateProjectContext(root, [".", "pkg"]);
			expect(context.files.map((file) => `${file.role}:${file.path}`)).toEqual([
				"manifest:package.json",
				"manifest:pkg/package.json",
				"tsconfig:pkg/tsconfig.node.json",
				"tsconfig:tsconfig.build.json",
				"tsconfig:tsconfig.json",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reports unreadable tsconfig files as read failures", async () => {
		const root = await makeRoot();
		try {
			// A broken symlink lists in readdir but cannot be read.
			symlinkSync(join(root, "nowhere.json"), join(root, "tsconfig.broken.json"));
			const context = await enumerateProjectContext(root, ["."]);
			expect(context.files).toEqual([]);
			expect(context.readFailures).toEqual([
				{ path: "package.json", reason: expect.any(String) },
				{
					path: "tsconfig.broken.json",
					reason: expect.stringContaining("ENOENT"),
				},
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("processes de-duplicated package roots in deterministic order", async () => {
		const root = await makeRoot();
		try {
			await writeManifest(root, "b", { name: "b" });
			await writeManifest(root, "a", { name: "a" });
			await writeManifest(root, ".", { name: "root" });
			const context: ProjectContext = await enumerateProjectContext(root, ["b", ".", "a", "b"]);
			expect(context.dependencies.map((decl) => decl.packagePath)).toEqual([".", "a", "b"]);
			expect(DEPENDENCY_SECTIONS).toHaveLength(4);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("stageWorkspaceView (project-aware integration)", () => {
	test("stages enumerated context into the view with provenance semantics", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "A\n");
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({
					name: "root-pkg",
					dependencies: { zod: "^4", typescript: "~6" },
					devDependencies: { "@biomejs/biome": "^2" },
					peerDependencies: { bun: ">=1" },
					optionalDependencies: { knip: "^6" },
					main: "./src/index.ts",
					module: "./src/index.ts",
					bin: { trellis: "./src/cli/main.ts" },
				}),
			);
			await writeFile(join(root, "tsconfig.json"), "{}");
			await writeFile(join(root, "tsconfig.base.json"), "{}");
			await mkdir(join(root, "pkg"), { recursive: true });
			await writeFile(
				join(root, "pkg/package.json"),
				'{"name":"nested","main":"./lib.ts","bin":{"nested":"./bin.ts"}}',
			);
			await writeFile(join(root, "pkg/b.ts"), "B\n");
			await writeFile(join(root, "pkg/tsconfig.build.json"), "{}");

			// No explicit packageRoots: defaults derive from the selection ∪ root.
			const inventory = await discoverSourceInventory(root);
			const view = await stageWorkspaceView({
				root,
				files: inventory.files.map((file) => ({
					path: file.path,
					sourceSet: file.sourceSet,
					packagePath: file.packagePath,
				})),
				mode: "project-aware",
			});
			try {
				expect(view.provenance.mode).toBe("project-aware");
				expect(view.contextFiles.map((file) => `${file.role}:${file.path}`)).toEqual([
					"manifest:package.json",
					"manifest:pkg/package.json",
					"tsconfig:pkg/tsconfig.build.json",
					"tsconfig:tsconfig.base.json",
					"tsconfig:tsconfig.json",
				]);
				expect(await readFile(join(view.stagedRoot, "pkg/package.json"), "utf8")).toContain(
					'"nested"',
				);
				expect(view.provenance.contextFiles).toEqual([
					{ path: "package.json", role: "manifest" },
					{ path: "pkg/package.json", role: "manifest" },
					{ path: "pkg/tsconfig.build.json", role: "tsconfig" },
					{ path: "tsconfig.base.json", role: "tsconfig" },
					{ path: "tsconfig.json", role: "tsconfig" },
				]);
				expect(view.provenance.dependencyDeclarations).toEqual([
					{
						packagePath: ".",
						sections: {
							dependencies: ["typescript", "zod"],
							devDependencies: ["@biomejs/biome"],
							peerDependencies: ["bun"],
							optionalDependencies: ["knip"],
						},
					},
					{
						packagePath: "pkg",
						sections: {
							dependencies: [],
							devDependencies: [],
							peerDependencies: [],
							optionalDependencies: [],
						},
					},
				]);
				expect(view.provenance.entryRoots).toEqual([
					{ packagePath: ".", entries: ["./src/cli/main.ts", "./src/index.ts"] },
					{ packagePath: "pkg", entries: ["./bin.ts", "./lib.ts"] },
				]);
				expect(view.provenance.contextIssues).toEqual([]);
				// Context is part of the snapshot: package.json drift is reported.
				await writeFile(join(root, "package.json"), '{"name":"root-pkg","main":"./other.ts"}');
				const drift = await view.detectDrift();
				expect(drift.entries.map((entry) => entry.path)).toEqual(["package.json"]);
			} finally {
				await view.cleanup();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
