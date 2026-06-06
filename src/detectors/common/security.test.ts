import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext, SPAWN_FAILURE_EXIT } from "../context.ts";
import type { DetectionContext, ExecResult } from "../types.ts";
import {
	automatedSecurityReview,
	branchProtection,
	minReleaseAge,
	parseRemote,
	privacyCompliance,
	secretScanning,
} from "./security.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
	run?: DetectionContext["run"],
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-sec-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["typescript"] });
	return run ? { ...ctx, run } : ctx;
}

const stubRun =
	(table: Record<string, ExecResult>): DetectionContext["run"] =>
	async (argv) =>
		table[`${argv[0]} ${argv[1]}`] ?? {
			exitCode: SPAWN_FAILURE_EXIT,
			stdout: "",
			stderr: "",
			timedOut: false,
		};

const res = (exitCode: number, stdout = ""): ExecResult => ({
	exitCode,
	stdout,
	stderr: "",
	timedOut: false,
});

describe("parseRemote", () => {
	test("parses scp-style github", () => {
		expect(parseRemote("git@github.com:owner/repo.git")).toEqual({
			host: "github",
			slug: "owner/repo",
		});
	});

	test("parses https gitlab", () => {
		expect(parseRemote("https://gitlab.com/grp/sub/proj.git")).toEqual({
			host: "gitlab",
			slug: "grp/sub/proj",
		});
	});

	test("classifies an unknown host as other", () => {
		expect(parseRemote("https://example.com/o/r")).toEqual({ host: "other", slug: "o/r" });
	});

	test("rejects non-slug URLs", () => {
		expect(parseRemote("")).toBeNull();
		expect(parseRemote("https://github.com/justone")).toBeNull();
	});
});

describe("branchProtection", () => {
	const githubRemote = { "git remote": res(0, "git@github.com:o/r.git\n") };

	test("not-applicable with no origin remote", async () => {
		const r = await branchProtection(await repo({}, stubRun({ "git remote": res(1) })));
		expect(r.naKind).toBe("not-applicable");
	});

	test("passes when GitHub rulesets exist", async () => {
		const ctx = await repo({}, stubRun({ ...githubRemote, "gh api": res(0, "2\n") }));
		expect((await branchProtection(ctx)).numerator).toBe(1);
	});

	test("fails when GitHub has zero rulesets", async () => {
		const ctx = await repo({}, stubRun({ ...githubRemote, "gh api": res(0, "0\n") }));
		expect((await branchProtection(ctx)).numerator).toBe(0);
	});

	test("no-detector when gh is not installed", async () => {
		const ctx = await repo({}, stubRun(githubRemote));
		expect((await branchProtection(ctx)).naKind).toBe("no-detector");
	});

	test("no-detector for an unsupported host", async () => {
		const ctx = await repo({}, stubRun({ "git remote": res(0, "https://example.com/o/r\n") }));
		expect((await branchProtection(ctx)).naKind).toBe("no-detector");
	});
});

describe("automatedSecurityReview", () => {
	test("passes with a CodeQL workflow", async () => {
		expect(
			(await automatedSecurityReview(await repo({ ".github/workflows/codeql.yml": "x" })))
				.numerator,
		).toBe(1);
	});

	test("passes with an audit step in CI", async () => {
		expect(
			(await automatedSecurityReview(await repo({ ".github/workflows/ci.yml": "run: bun audit" })))
				.numerator,
		).toBe(1);
	});

	test("not-applicable without SAST/audit", async () => {
		expect((await automatedSecurityReview(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("secretScanning", () => {
	test("passes with gitleaks in CI", async () => {
		expect(
			(
				await secretScanning(
					await repo({ ".github/workflows/sec.yml": "uses: gitleaks/gitleaks-action" }),
				)
			).numerator,
		).toBe(1);
	});

	test("passes with detect-secrets in pre-commit", async () => {
		expect(
			(await secretScanning(await repo({ ".pre-commit-config.yaml": "- repo: detect-secrets" })))
				.numerator,
		).toBe(1);
	});

	test("not-applicable without secret scanning", async () => {
		expect((await secretScanning(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("minReleaseAge", () => {
	test("passes with a Dependabot cooldown", async () => {
		expect(
			(
				await minReleaseAge(
					await repo({ ".github/dependabot.yml": "cooldown:\n  default-days: 5" }),
				)
			).numerator,
		).toBe(1);
	});

	test("passes with Renovate minimumReleaseAge", async () => {
		expect(
			(await minReleaseAge(await repo({ "renovate.json": '{"minimumReleaseAge":"3 days"}' })))
				.numerator,
		).toBe(1);
	});

	test("fails (non-skippable) without a release-age gate", async () => {
		const r = await minReleaseAge(await repo({ ".github/dependabot.yml": "version: 2" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("privacyCompliance", () => {
	test("passes with a privacy doc", async () => {
		expect((await privacyCompliance(await repo({ "PRIVACY.md": "x" }))).numerator).toBe(1);
	});

	test("not-applicable without privacy evidence", async () => {
		expect((await privacyCompliance(await repo({}))).naKind).toBe("not-applicable");
	});
});
