import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import {
	automatedPrReview,
	backlogHealth,
	codeowners,
	issueLabelingSystem,
	issueTemplates,
	prTemplates,
} from "./process.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-proc-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("codeowners", () => {
	test("passes a CODEOWNERS with ownership rules", async () => {
		expect((await codeowners(await repo({ CODEOWNERS: "* @team\n" }))).numerator).toBe(1);
	});

	test("fails a CODEOWNERS with only comments", async () => {
		expect((await codeowners(await repo({ ".github/CODEOWNERS": "# nobody\n" }))).numerator).toBe(
			0,
		);
	});

	test("fails when absent", async () => {
		expect((await codeowners(await repo({}))).numerator).toBe(0);
	});
});

describe("issueTemplates", () => {
	test("passes with a template in ISSUE_TEMPLATE/", async () => {
		expect(
			(await issueTemplates(await repo({ ".github/ISSUE_TEMPLATE/bug.yml": "x" }))).numerator,
		).toBe(1);
	});

	test("fails when none committed", async () => {
		expect((await issueTemplates(await repo({}))).numerator).toBe(0);
	});
});

describe("issueLabelingSystem", () => {
	test("passes with a labels.yml", async () => {
		expect((await issueLabelingSystem(await repo({ ".github/labels.yml": "x" }))).numerator).toBe(
			1,
		);
	});

	test("passes with a label-sync workflow", async () => {
		expect(
			(
				await issueLabelingSystem(
					await repo({ ".github/workflows/labels.yml": "uses: actions/labeler" }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails without a labeling scheme", async () => {
		expect((await issueLabelingSystem(await repo({}))).numerator).toBe(0);
	});
});

describe("prTemplates", () => {
	test("passes with a PR template", async () => {
		expect(
			(await prTemplates(await repo({ ".github/pull_request_template.md": "x" }))).numerator,
		).toBe(1);
	});

	test("fails when absent", async () => {
		expect((await prTemplates(await repo({}))).numerator).toBe(0);
	});
});

describe("automatedPrReview", () => {
	test("passes with a coderabbit config", async () => {
		expect((await automatedPrReview(await repo({ ".coderabbit.yaml": "x" }))).numerator).toBe(1);
	});

	test("not-applicable without a review bot", async () => {
		expect((await automatedPrReview(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("backlogHealth", () => {
	test("passes with a stale-bot config", async () => {
		expect((await backlogHealth(await repo({ ".github/stale.yml": "x" }))).numerator).toBe(1);
	});

	test("not-applicable without grooming automation", async () => {
		expect((await backlogHealth(await repo({}))).naKind).toBe("not-applicable");
	});
});
