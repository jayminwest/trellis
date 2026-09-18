/**
 * Shared fixtures for the provider-selection core tests (SPEC §16.3–16.5,
 * plan `pl-43c5` step 15 — trellis-15e3; used by `providers.test.ts` and
 * `provider-policy.test.ts`).
 *
 * Real workspaces only: every helper writes actual files into a temp repo —
 * no filesystem or SQLite mocks — and the real-binary helper resolves the
 * pinned jscpd artifact exactly as the audit does, so provider tests skip
 * (never fabricate) where the pinned tool is not installed.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { resolvePinnedTool } from "../providers/resolve.ts";

/** Pinned run clock so assembled reports differ only in `run.durationMs`. */
export const PINNED = new Date("2026-01-01T00:00:00.000Z");

/** Real-binary tests run only where the pinned artifact resolved on this host. */
export const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";

/** Real-binary knip tests run only where the pinned knip resolved on this host. */
export const KNIP_TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** A clone fixture above every pinned threshold (105 tokens, 13 lines, CC 10). */
export const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" +
	"\tconst s = a + b;\n" +
	"\tif (a > 0) return 1;\n" +
	"\tif (a > 1) return 2;\n" +
	"\tif (a > 2) return 3;\n" +
	"\tif (a > 3) return 4;\n" +
	"\tif (a > 4) return 5;\n" +
	"\tif (a > 5) return 6;\n" +
	"\tif (a > 6) return 7;\n" +
	"\tif (a > 7) return 8;\n" +
	"\tif (a > 8) return 9;\n" +
	"\treturn s;\n" +
	"}\n";

/** A far-below-threshold file (3 tokens) the pinned tool omits from its statistics. */
export const TINY_FN = "export const tiny = 1;\n";

/** The audit configuration with the given provider selection and policy (defaults elsewhere). */
export function providerAuditConfig(
	providers: AuditConfig["providers"],
	policy: AuditConfig["policy"] = { budgets: {}, failOnNew: [], requireEvidence: [] },
): AuditConfig {
	return { source: { exclude: [], classify: {} }, providers, policy };
}

/** Write `content` to `relPath` under `root`, creating parent dirs. */
export async function putFile(root: string, relPath: string, content: string): Promise<void> {
	const abs = join(root, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** Seed a workspace with one exact clone pair across two production files. */
export async function seedClonePair(root: string): Promise<void> {
	await putFile(
		root,
		"package.json",
		JSON.stringify({ name: "fixture-providers", version: "1.0.0" }),
	);
	await putFile(root, "src/clone-a.ts", CLONE_FN);
	await putFile(root, "src/clone-b.ts", CLONE_FN);
}

/** The number of trellis-owned staged scratch directories currently in tmpdir. */
export async function stagedScratchCount(): Promise<number> {
	const entries = await readdir(tmpdir());
	return entries.filter((entry) => entry.startsWith("trellis-staged-")).length;
}

/** The carried analyses' provider ids (both versions; pre-provider carries none). */
export function carriedProviderIds(report: AuditReport): string[] {
	return report.schemaVersion === "1.1.0"
		? report.evidence.analyses.map((analysis) => analysis.provider.id)
		: [];
}

/** The evidence area of an evidence-carrying report (fails fast otherwise). */
export function evidenceArea(report: AuditReport) {
	if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
	return report.evidence;
}

/** The evidence entry of `providerId`, narrowed (fails fast when absent). */
export function providerEntry(report: AuditReport, providerId: string) {
	const area = evidenceArea(report);
	const entry = area.analyses.find((analysis) => analysis.provider.id === providerId);
	if (entry === undefined) {
		throw new Error(`expected the report to carry "${providerId}" evidence`);
	}
	return entry;
}
