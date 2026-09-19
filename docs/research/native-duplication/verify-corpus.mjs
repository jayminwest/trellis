/** Offline corpus preparation verifier; never imported by the audit. No downloads or target execution. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const relative = z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== ".." && part !== ""));
const entry = z.strictObject({
 id: z.string().regex(/^[a-z0-9-]+$/), repository: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/),
 snapshotDir: relative, scope: relative,
 files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
 treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
 budget: z.strictObject({ maxMedianCoreMs: z.number().positive(), maxMedianAuditMs: z.number().positive(), maxPeakRssMiB: z.number().positive() }),
});
export const manifestSchema = z.strictObject({
 protocol: z.literal("native-duplication-v1"),
 digest: z.literal("sha256(JSON.stringify(sorted [relative-path, content-sha256] pairs))"),
 referenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
 environment: z.record(z.string(), z.string()),
 resources: z.strictObject(Object.fromEntries([
  "maxTokens", "maxMatchWork", "maxStreams", "maxWorkingCells", "maxGroups", "maxOccurrences",
  "checkpointEvery", "oracleMaxTokens", "runs", "maxSingleRunMs", "stressMaxCoreMs", "stressMaxAuditMs", "stressMaxPeakRssMiB",
 ].map((key) => [key, z.number().int().positive()]))),
 entries: z.array(entry).min(14),
}).superRefine((manifest, context) => {
 const ids = new Set(manifest.entries.map((item) => item.id));
 if (ids.size !== manifest.entries.length) context.addIssue({ code: "custom", message: "duplicate corpus id" });
 for (const id of ["trellis-self", "hono-src", "zod-package", "clean-small", "clone-base", "clone-removed", "branch-base", "branch-grown", "acyclic", "cyclic", "dilution-base", "dilution-grown", "test-separation", "incomplete-parse"]) {
  if (!ids.has(id)) context.addIssue({ code: "custom", message: `missing required corpus ${id}` });
 }
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Hash every regular file in the prepared scope; symlinks are rejected rather than followed. */
export async function fingerprint(root) {
 const rows = [];
 let bytes = 0;
 async function walk(relativePath) {
  const children = await readdir(join(root, relativePath), { withFileTypes: true });
  for (const child of children) {
   const path = relativePath ? `${relativePath}/${child.name}` : child.name;
   if (child.isSymbolicLink()) throw new Error(`snapshot contains a symlink: ${path}`);
   if (child.isDirectory()) await walk(path);
   else if (child.isFile()) {
    const data = await readFile(join(root, path)); bytes += data.length;
    rows.push([path, sha(data)]);
   } else throw new Error(`unsupported snapshot entry: ${path}`);
  }
 }
 await walk("");
 rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
 return { files: rows.length, bytes, treeSha256: sha(JSON.stringify(rows)) };
}

export async function verifyCorpus(root, manifestPath = new URL("manifest.json", import.meta.url)) {
 const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
 for (const item of manifest.entries) {
  const actual = await fingerprint(join(root, item.snapshotDir, item.scope));
  for (const field of ["files", "bytes", "treeSha256"]) {
   if (actual[field] !== item[field]) throw new Error(`${item.id}: ${field} does not match pinned corpus`);
  }
  console.log(`${item.id}: verified ${actual.files} files, ${actual.treeSha256}`);
 }
 return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 if (!process.argv[2]) throw new Error("usage: bun verify-corpus.mjs PREPARED_CORPUS_ROOT");
 await verifyCorpus(resolve(process.argv[2]));
}
