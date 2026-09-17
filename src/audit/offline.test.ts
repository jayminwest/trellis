import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditReportSchema, measurementPayload } from "../contract/index.ts";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";

const CLI = resolve(import.meta.dir, "../cli/main.ts");
const SDK = pathToFileURL(resolve(import.meta.dir, "../client/index.ts")).href;

/** Include file bytes, so overwrites are detected as well as newly created files. */
function snapshot(root: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [path.slice(root.length + 1), readFileSync(path).toString("base64")];
			})
			.sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
	);
}

describe("offline public audit paths", () => {
	test("audits through CLI, SDK and fleet without tools, credentials, execution or writes", async () => {
		const work = mkdtempSync(join(tmpdir(), "trellis-offline-"));
		const root = join(work, "workspace");
		try {
			await seedFixtureRepo(root, "sloppy");
			// These would fail immediately if the audit imported config or ran a target check.
			writeFileSync(join(root, "trellis.config.ts"), 'throw new Error("executed config");\n');
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({
					name: "offline-fixture",
					scripts: { verify: "exit 91", test: "exit 92", prepare: "exit 93" },
				}),
			);
			const targets = join(work, "targets.yaml");
			writeFileSync(targets, `targets:\n  - id: offline\n    path: ${JSON.stringify(root)}\n`);
			const guard = join(work, "guard.ts");
			// Stub only external process/network boundaries, isolated from the test worker.
			writeFileSync(
				guard,
				`import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const attempts: string[] = [];
const deny = (name: string) => () => {
  attempts.push(name);
  throw new Error("forbidden external boundary: " + name);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[name] = deny(name);
}
syncBuiltinESMExports();
Bun.spawn = deny("Bun.spawn");
Bun.spawnSync = deny("Bun.spawnSync");
globalThis.fetch = deny("fetch");
process.on("exit", () => {
  if (attempts.length) {
    console.error(attempts.join(", "));
    process.exitCode = 94;
  }
});
`,
			);
			const runner = join(work, "sdk.ts");
			writeFileSync(
				runner,
				`const sdk = await import(${JSON.stringify(SDK)});
const direct = await sdk.audit(${JSON.stringify(root)});
const fleet = await sdk.fleet(${JSON.stringify(targets)});
console.log(JSON.stringify({ direct, fleet }));
`,
			);
			const before = snapshot(work);
			async function run(args: string[]): Promise<string> {
				const child = Bun.spawn([process.execPath, "--preload", guard, ...args], {
					cwd: root,
					// No inherited API keys, model settings, Git configuration or executable tools.
					env: { PATH: "", TRELLIS_DB: join(work, "unexpected.db"), TRELLIS_LOG_LEVEL: "silent" },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				return stdout;
			}
			const cli = auditReportSchema.parse(JSON.parse(await run([CLI, "audit", root, "--json"])));
			const sdk = JSON.parse(await run([runner]));
			const direct = auditReportSchema.parse(sdk.direct.report);
			expect(measurementPayload(cli)).toEqual(measurementPayload(direct));
			expect(sdk.direct.historyRunId).toBeUndefined();
			expect(sdk.fleet.entries).toHaveLength(1);
			const fleetReport = auditReportSchema.parse(sdk.fleet.entries[0].report);
			expect(measurementPayload(fleetReport)).toEqual(measurementPayload(direct));
			const fleetCli = JSON.parse(await run([CLI, "fleet", "--targets", targets, "--json"]));
			expect(measurementPayload(auditReportSchema.parse(fleetCli.entries[0].report))).toEqual(
				measurementPayload(direct),
			);
			expect(snapshot(work)).toEqual(before);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
