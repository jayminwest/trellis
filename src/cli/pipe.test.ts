import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CLI pipe output", () => {
	for (const code of [0, 2]) {
		test(`drains a large JSON report to a slow reader before exit ${code}`, async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-pipe-"));
			try {
				const imports = Array.from(
					{ length: 300 },
					(_, i) => `import './missing-${i}-${"x".repeat(1500)}';`,
				);
				await writeFile(join(root, "main.ts"), imports.join("\n"));
				if (code === 2) await writeFile(join(root, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
				const artifact = join(root, "report.json");
				const child = spawn(
					process.execPath,
					[join(import.meta.dir, "main.ts"), "audit", root, "--json", "--quiet", "--out", artifact],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				const exited = new Promise<number | null>((resolve, reject) => {
					child.on("exit", resolve);
					child.on("error", reject);
				});
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				const chunks: Buffer[] = [];
				for await (const chunk of child.stdout) {
					chunks.push(Buffer.from(chunk));
					await Bun.sleep(5);
				}
				const stdout = Buffer.concat(chunks).toString();
				expect(await exited).toBe(code);
				expect(stdout.length).toBeGreaterThan(1_048_576);
				expect(JSON.parse(stdout)).toEqual(JSON.parse(await readFile(artifact, "utf8")));
				if (code === 2) expect(stderr).toContain("policy max-index failed");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
