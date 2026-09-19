/** Fresh-process, offline duplication measurement. No target code/config execution. */
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadAuditConfig } from "../../../src/config/index.ts";
import { discoverSourceInventory } from "../../../src/discovery/index.ts";
import { buildSyntaxInventory } from "../../../src/syntax/index.ts";
import { measureCandidateScope } from "../../../src/metrics/duplication-candidate.ts";
import { repeatedSource, sourceFile } from "../../../src/metrics/tests/duplication-fixtures.ts";

const request = z.strictObject({
 engine: z.enum(["candidate", "reference"]), root: z.string(), referenceRoot: z.string(),
 copies: z.union([z.literal(0), z.literal(2), z.literal(10), z.literal(40)]).default(0),
}).parse(JSON.parse(process.argv[2] ?? "null"));
const reference = request.engine === "reference"
 ? await import(pathToFileURL(join(request.referenceRoot, "src/metrics/analyze-duplication.ts")).href) : null;
const begin = performance.now();
let syntax;
if (request.copies) {
 const files = Array.from({ length: request.copies }, (_, i) => sourceFile(`f${i}.ts`, repeatedSource(`fn${i}`)));
 syntax = { root: "/stress", compilerVersion: "controlled", files, functionCount: files.length,
  diagnostics: [], completeness: "complete" };
} else {
 const root = resolve(request.root);
 const config = await loadAuditConfig(root);
 syntax = await buildSyntaxInventory(await discoverSourceInventory(root, { source: config.source }));
}
const coreBegin = performance.now();
const scopes = {};
const operations = {};
if (reference) Object.assign(scopes, reference.analyzeDuplication(syntax).scopes);
else for (const sourceSet of ["production", "test"]) {
 const files = syntax.files.filter((file) => file.sourceSet === sourceSet);
 const measured = measureCandidateScope(files);
 scopes[sourceSet] = { sourceSet, files: files.length, tokenCount: measured.tokenCount,
  codeLines: measured.totals?.codeLines ?? null, duplicatedLines: measured.totals?.duplicatedLines ?? null,
  density: measured.totals?.density ?? null, groups: measured.groups,
  diagnosticFiles: files.filter((file) => file.diagnostics.length).map((file) => file.path).sort(),
  exhaustion: measured.exhaustion };
 operations[sourceSet] = measured.work;
}
const coreMs = performance.now() - coreBegin;
const auditMs = performance.now() - begin;
console.log(JSON.stringify({ scopes, operations, measurement: { coreMs, auditMs,
 peakRssMiB: process.resourceUsage().maxRSS / (process.platform === "darwin" ? 1024 * 1024 : 1024) } }));
