/** Offline production cutover proof against the pinned pre-cutover core. */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { auditWorkspace } from "../../../src/audit/audit.ts";
import { verifyCorpus } from "./verify-corpus.mjs";

const [rootArg, outputArg] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const root = resolve(rootArg);
const manifest = await verifyCorpus(root);
const reference = await import(pathToFileURL(join(root, "trellis/src/audit/audit.ts")).href);
const entries = [];
for (const entry of manifest.entries) {
 const path = join(root, entry.snapshotDir, entry.scope);
 const before = await reference.auditWorkspace(path);
 const after = await auditWorkspace(path);
 const changes = Object.keys(before.metrics).filter((id) => !isDeepStrictEqual(before.metrics[id], after.metrics[id]));
 for (const id of changes) {
  if (!id.startsWith("duplication.") || before.metrics[id].state !== "incomplete") throw new Error(`${entry.id}: formerly complete metric differs: ${id}`);
 }
 const nonClones = (report) => report.findings.filter((finding) => finding.kind !== "duplication.clone-group");
 if (!isDeepStrictEqual(nonClones(before), nonClones(after))) throw new Error(`${entry.id}: non-duplication findings differ`);
 if (!isDeepStrictEqual(before.safeguards, after.safeguards)) throw new Error(`${entry.id}: safeguards differ`);
 if (!changes.length && !isDeepStrictEqual(before.score, after.score)) throw new Error(`${entry.id}: unchanged metrics changed score`);
 if (after.scoringVersion !== before.scoringVersion) throw new Error("scoring recalibration is forbidden");
 entries.push({ id: entry.id, oldIndex: before.score.index, newIndex: after.score.index,
  oldPartial: before.score.partial, newPartial: after.score.partial, changedMetrics: changes,
  remainingIncompleteMetrics: Object.keys(after.metrics).filter((id) => after.metrics[id].state === "incomplete"),
  exactMetricAndScoreParity: changes.length === 0 });
 console.log(`${entry.id}: ${before.score.index} -> ${after.score.index}; ${changes.length ? "newly complete duplication only" : "exact metric/score parity"}`);
}
await verifyCorpus(root);
await writeFile(resolve(outputArg), `${JSON.stringify({ referenceCommit: manifest.referenceCommit, analyzerVersion: "0.2.3", scoringVersion: "0.2.0-provisional", passed: true, entries }, null, 2)}\n`);
