/** Independent raw-membership proof, separate from timing/RSS measurement. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { loadAuditConfig } from "../../../src/config/index.ts";
import { discoverSourceInventory } from "../../../src/discovery/index.ts";
import { buildSyntaxInventory } from "../../../src/syntax/index.ts";
import { collectTokenStream } from "../../../src/metrics/duplication.ts";
import { rankTokenStreams } from "../../../src/metrics/duplication-index-input.ts";
import { suffixArray, longestCommonPrefixes } from "../../../src/metrics/duplication-suffix.ts";
import { extractCloneGroups } from "../../../src/metrics/duplication-extract.ts";
import { DuplicationWork } from "../../../src/metrics/duplication-work.ts";
import { repeatedStreams } from "../../../src/metrics/tests/duplication-fixtures.ts";
import { verifyCorpus } from "./verify-corpus.mjs";

const [rootArg, outputArg] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const root = resolve(rootArg);
const manifest = await verifyCorpus(root);
const referenceDirectory = join(root, "trellis/src/metrics");
let source = await readFile(join(referenceDirectory, "duplication-detect.ts"), "utf8");
// Export-only instrumentation of the pinned trellis engine, never target source.
// Type erasure and absolute imports do not alter its matching algorithm.
source = source.replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(join(referenceDirectory, relative)).href)}`);
source += `\nexport function rawReference(streams) {
 const data = concatenate(streams), budget = DEFAULT_DUPLICATION_BUDGET;
 if (data.kinds.length > budget.maxTokens) return { complete: false, work: 0 };
 const work = { count: 0, exhausted: false };
 const groups = collectRawGroups(data, buildWindows(data), work, budget);
 return { complete: !work.exhausted, groups, starts: data.fileStart, work: work.count };
}\n`;
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
const scratch = await mkdtemp(join(tmpdir(), "trellis-raw-proof-"));
let legacy;
try {
 const modulePath = join(scratch, "reference.mjs");
 await writeFile(modulePath, compiled);
 legacy = await import(pathToFileURL(modulePath).href);
} finally { await rm(scratch, { recursive: true, force: true }); }
const records = [];
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function proof(groups, starts, streams) {
 let comparisons = 0;
 const charge = () => { if (++comparisons > manifest.resources.maxMatchWork) throw new Error("raw invariant proof work exhausted"); };
 const canonical = [];
 for (const sameLength of groups.values()) for (const group of sameLength) {
  const rep = streams[group.rep.file];
  const local = group.rep.start - starts[group.rep.file];
  const content = JSON.stringify(rep.kinds.slice(local, local + group.length));
  const members = [];
  const contexts = [];
  for (const member of group.members.values()) {
   charge();
   const stream = streams[member.file];
   const start = member.start - starts[member.file], end = member.end - starts[member.file];
   if (start < 0 || end > stream.kinds.length || end - start !== group.length) throw new Error("invalid raw file interval");
   for (let i = 0; i < group.length; i++) { charge(); if (stream.kinds[start+i] !== rep.kinds[local+i]) throw new Error("raw content mismatch"); }
   members.push({ path: stream.path, start, end });
   contexts.push({ left: start ? stream.kinds[start-1] : `start:${member.file}`,
    right: end < stream.kinds.length ? stream.kinds[end] : `end:${member.file}` });
  }
  for (const context of contexts) {
   if (!contexts.some((other) => { charge(); return context.left !== other.left && context.right !== other.right; })) throw new Error("member has no maximal partner");
  }
  members.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.start-b.start || a.end-b.end);
  canonical.push({ content, members });
 }
 canonical.sort((a,b) => a.content < b.content ? -1 : a.content > b.content ? 1 : 0);
 return { canonical, comparisons };
}

async function streamsFor(entry) {
 if (entry.copies) return { production: repeatedStreams(entry.copies), test: [] };
 const scope = join(root, entry.snapshotDir, entry.scope);
 const config = await loadAuditConfig(scope);
 const syntax = await buildSyntaxInventory(await discoverSourceInventory(scope, { source: config.source }));
 return Object.fromEntries(["production", "test"].map((set) => [set, syntax.files.filter((file) => file.sourceSet === set).map(collectTokenStream)]));
}
for (const entry of [...manifest.entries, ...[2,10,40].map((copies) => ({ id: `copies-${copies}`, copies }))]) {
 const sets = await streamsFor(entry);
 for (const [set, streams] of Object.entries(sets)) {
  const work = new DuplicationWork();
  const data = rankTokenStreams(streams, work);
  const sa = suffixArray(data.tokens, data.alphabetSize, work);
  const lcp = longestCommonPrefixes(data.tokens, sa, work);
  const raw = extractCloneGroups(data, sa, lcp, work);
  const actual = proof(raw, data.fileStart, streams);
  const reference = legacy.rawReference(streams);
  let compared = false;
  if (reference.complete) {
   const expected = proof(reference.groups, reference.starts, streams);
   if (!isDeepStrictEqual(actual.canonical, expected.canonical)) throw new Error(`${entry.id}/${set}: complete-reference raw groups differ`);
   compared = true;
  }
  records.push({ id: entry.id, sourceSet: set, rawGroups: actual.canonical.length,
   digest: sha(actual.canonical), invariantComparisons: actual.comparisons, referenceComplete: reference.complete,
   referenceWork: reference.work, exactRawParity: compared });
  console.log(`${entry.id}/${set}: invariant PASS; ${compared ? "exact raw parity PASS" : "old incomplete, not an oracle"}`);
 }
}
await verifyCorpus(root);
await writeFile(resolve(outputArg), `${JSON.stringify({ referenceCommit: manifest.referenceCommit, passed: true, records }, null, 2)}\n`);
