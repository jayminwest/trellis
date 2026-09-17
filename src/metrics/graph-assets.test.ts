import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/audit.ts";

describe("asset import resolution", () => {
	test("resolves exact, wildcard, inherited and relative assets while retaining missing targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-assets-"));
		try {
			await mkdir(join(root, "config"));
			await mkdir(join(root, "src"));
			await writeFile(
				join(root, "config/base.json"),
				JSON.stringify({
					compilerOptions: {
						paths: {
							"@/*": ["../absent/*", "../src/*"],
							theme: ["../src/index.css"],
							"@/blocked/*": ["../missing/*"],
							"@/index.css": ["../src/index.css"],
							dependency: ["../node_modules/pkg/index.css"],
						},
					},
				}),
			);
			await writeFile(join(root, "tsconfig.json"), '{"extends":"./config/base.json"}');
			await writeFile(join(root, "src/index.css"), "body {}");
			await writeFile(join(root, "src/logo.svg"), "<svg/>");
			await mkdir(join(root, "src/blocked"));
			await writeFile(join(root, "src/blocked/logo.svg"), "<svg/>");
			await mkdir(join(root, "node_modules/pkg"), { recursive: true });
			await writeFile(join(root, "node_modules/pkg/index.css"), "body {}");
			const main = join(root, "src/main.ts");
			await writeFile(
				main,
				"import '@/index.css';\nimport '@/logo.svg';\nimport 'theme';\nimport './index.css';",
			);
			const report = await auditWorkspace(root);
			expect(report.metrics["graph.edges.unresolved"]?.value).toBe(0);
			expect(report.metrics["import-cycle.groups"]?.state).toBe("complete");
			expect(
				report.findings.filter((finding) => finding.kind === "graph.unresolved-import"),
			).toHaveLength(0);
			await writeFile(
				main,
				"import '@/missing.css';\nimport './missing.css';\nimport '@/blocked/logo.svg';\nimport 'dependency';",
			);
			const missing = await auditWorkspace(root);
			expect(missing.metrics["graph.edges.unresolved"]?.value).toBe(4);
			expect(missing.metrics["import-cycle.groups"]?.state).toBe("incomplete");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
