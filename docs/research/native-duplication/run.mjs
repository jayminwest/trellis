/** Frozen offline acceptance. Acquisition is explicitly outside this harness. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { cpus } from "node:os";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DUPLICATION_LIMITS } from "../../../src/metrics/duplication-work.ts";
import { verifyCorpus } from "./verify-corpus.mjs";

const args = z.tuple([z.string().min(1), z.string().min(1)]).parse(process.argv.slice(2));
const root = resolve(args[0]);
const output = resolve(args[1]);
const manifest = await verifyCorpus(root);
for (const [key, value] of Object.entries(DUPLICATION_LIMITS)) {
 if (manifest.resources[key] !== value) throw new Error(`${key}: frozen budget mismatch`);
}
const measurement = z.strictObject({ coreMs: z.number().nonnegative(), auditMs: z.number().nonnegative(), peakRssMiB: z.number().positive() });
const scope = z.object({ sourceSet: z.string(), files: z.number().int().nonnegative(), tokenCount: z.number().int().nonnegative(),
 groups: z.array(z.unknown()), exhaustion: z.unknown().nullable() }).passthrough();
const response = z.strictObject({ measurement, operations: z.record(z.string(), z.unknown()),
 scopes: z.strictObject({ production: scope, test: scope }) });
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
 ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const median = (values) => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const entries = [...manifest.entries.map((entry) => ({ ...entry, root: join(root, entry.snapshotDir, entry.scope), copies: 0 })),
 ...[2, 10, 40].map((copies) => ({ id: `copies-${copies}`, root: "/stress", copies, budget: {
  maxMedianCoreMs: manifest.resources.stressMaxCoreMs, maxMedianAuditMs: manifest.resources.stressMaxAuditMs,
  maxPeakRssMiB: manifest.resources.stressMaxPeakRssMiB } }))];
const sourceRoot = resolve(import.meta.dir, "../../..");
const sourcePaths = (await readdir(join(sourceRoot, "src/metrics")))
 .filter((name) => name.startsWith("duplication") && name.endsWith(".ts") && !name.endsWith(".test.ts"))
 .map((name) => `src/metrics/${name}`)
 .concat(["src/syntax/sloc.ts", "src/syntax/work.ts", "src/metrics/tests/duplication-fixtures.ts", "docs/research/native-duplication/measure.mjs"])
 .sort();
const candidateSources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) =>
 [path, createHash("sha256").update(await readFile(join(sourceRoot, path))).digest("hex")])));
const report = { protocol: manifest.protocol, referenceCommit: manifest.referenceCommit, candidateSources,
 algorithm: "SA-IS + Kasai; deterministic work accounting v2",
 host: { runtime: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
 runs: manifest.resources.runs, rss: "Bun getrusage maxRSS: bytes on Darwin, KiB elsewhere; converted to MiB",
 watchdogMs: manifest.resources.maxSingleRunMs, entries: [], passed: true };
await mkdir(output, { recursive: true });
for (const entry of entries) {
 const record = { id: entry.id, inputHash: entry.treeSha256 ?? digest({ copies: entry.copies, generator: "trellis-3577" }),
  budget: entry.budget, engines: {}, failures: [] };
 for (const engine of ["reference", "candidate"]) {
  const runs = [];
  for (let repetition = 0; repetition < manifest.resources.runs; repetition++) {
   const request = { engine, root: entry.root, referenceRoot: join(root, "trellis"), copies: entry.copies };
   const child = spawnSync(process.execPath, [join(import.meta.dir, "measure.mjs"), JSON.stringify(request)], {
    cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, NODE_PATH: resolve(import.meta.dir, "../../../node_modules") },
    encoding: "utf8", timeout: manifest.resources.maxSingleRunMs, maxBuffer: 128 * 1024 * 1024,
   });
   if (child.status !== 0 || child.error) {
    record.failures.push(`${engine} run ${repetition + 1}: ${child.error?.message ?? child.stderr.slice(-1000)}`);
    break;
   }
   const result = response.parse(JSON.parse(child.stdout));
   runs.push(result);
  }
  if (runs.length !== manifest.resources.runs) continue;
  const first = runs[0];
  const payloadHash = digest(first.scopes);
  if (runs.some((run) => digest(run.scopes) !== payloadHash || !isDeepStrictEqual(run.operations, first.operations))) {
   record.failures.push(`${engine}: nondeterministic payload or counters`);
  }
  const summary = { medianCoreMs: median(runs.map((run) => run.measurement.coreMs)),
   medianAuditMs: median(runs.map((run) => run.measurement.auditMs)),
   peakRssMiB: Math.max(...runs.map((run) => run.measurement.peakRssMiB)) };
  if (summary.medianCoreMs > entry.budget.maxMedianCoreMs || summary.medianAuditMs > entry.budget.maxMedianAuditMs || summary.peakRssMiB > entry.budget.maxPeakRssMiB) {
   record.failures.push(`${engine}: resource bound exceeded`);
  }
  record.engines[engine] = { ...summary, payloadHash, repetitions: runs.map((run) => run.measurement),
   operations: first.operations, scopes: Object.fromEntries(Object.entries(first.scopes).map(([set, data]) => [set,
    { files: data.files, tokens: data.tokenCount, groups: data.groups.length, exhaustion: data.exhaustion }])) };
  await writeFile(join(output, `${entry.id}-${engine}.json`), `${JSON.stringify(first.scopes, null, 2)}\n`);
  record.engines[engine].payload = first.scopes;
 }
 const reference = record.engines.reference?.payload;
 const candidate = record.engines.candidate?.payload;
 for (const set of ["production", "test"]) {
  if (!candidate || candidate[set].exhaustion !== null) record.failures.push(`${set}: candidate incomplete or unavailable`);
  if (reference?.[set].exhaustion === null && candidate && !isDeepStrictEqual(reference[set], candidate[set])) {
   record.failures.push(`${set}: complete-reference payload differs`);
  }
 }
 if (entry.copies === 40 && (candidate?.production.groups.length !== 1 || candidate.production.groups[0]?.members?.length !== 40 || candidate.production.duplicatedLines !== 1080)) record.failures.push("forty-copy construction invariant failed");
 for (const engine of Object.values(record.engines)) delete engine.payload;
 report.entries.push(record);
 report.passed &&= record.failures.length === 0;
 console.log(`${entry.id}: ${record.failures.length ? record.failures.join("; ") : "PASS"}`);
 await writeFile(join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
}
await verifyCorpus(root);
if (!report.passed) process.exitCode = 1;
