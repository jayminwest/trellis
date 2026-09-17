/** Research provenance only. Run with Bun from any cwd; writes JSON to stdout. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuditConfig } from "../../src/config/index.ts";
import { discoverSourceInventory } from "../../src/discovery/index.ts";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../", import.meta.url)));
const config = await loadAuditConfig(root);
const inventory = await discoverSourceInventory(root, { source: config.source });
const digest = createHash("sha256");
const files = [];
for (const file of inventory.files.filter((entry) => entry.sourceSet === "production")) {
	const bytes = await readFile(resolve(root, file.path));
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	digest.update(file.path).update("\0").update(sha256).update("\n");
	files.push({ path: file.path, bytes: bytes.length, sha256 });
}
console.log(
	JSON.stringify(
		{
			protocol: "provider-corpus-v1",
			scope: "trellis-discovery-production",
			sourceConfig: config.source ?? {},
			digestAlgorithm: "sha256 of sorted path + NUL + content-sha256 + newline",
			sha256: digest.digest("hex"),
			files,
		},
		null,
		2,
	),
);
