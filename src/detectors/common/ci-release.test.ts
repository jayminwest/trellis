import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext, SPAWN_FAILURE_EXIT } from "../context.ts";
import type { DetectionContext, ExecResult } from "../types.ts";
import {
	buildPerformanceTracking,
	deadFeatureFlagDetection,
	dependencyUpdateAutomation,
	deploymentFrequency,
	fastCiFeedback,
	featureFlagInfrastructure,
	monorepoTooling,
	progressiveRollout,
	releaseAutomation,
	releaseNotesAutomation,
	rollbackAutomation,
	vcsCliTools,
	versionDriftDetection,
} from "./ci-release.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Temp repo; `run` is optionally overridden to stub the CLI process boundary. */
async function repo(
	files: Record<string, string>,
	run?: DetectionContext["run"],
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-ci-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["typescript"] });
	return run ? { ...ctx, run } : ctx;
}

/** A `run` stub that answers a fixed result for a given argv[0]+argv[1], else exit 127. */
const stubRun =
	(table: Record<string, ExecResult>): DetectionContext["run"] =>
	async (argv) =>
		table[`${argv[0]} ${argv[1]}`] ?? {
			exitCode: SPAWN_FAILURE_EXIT,
			stdout: "",
			stderr: "",
			timedOut: false,
		};

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const exit = (code: number): ExecResult => ({
	exitCode: code,
	stdout: "",
	stderr: "",
	timedOut: false,
});

describe("vcsCliTools", () => {
	test("passes when gh is authenticated", async () => {
		const ctx = await repo({}, stubRun({ "gh auth": ok() }));
		expect((await vcsCliTools(ctx)).numerator).toBe(1);
	});

	test("passes when glab is authenticated (gh missing)", async () => {
		const ctx = await repo({}, stubRun({ "glab auth": ok() }));
		expect((await vcsCliTools(ctx)).numerator).toBe(1);
	});

	test("fails when neither CLI is on PATH", async () => {
		const r = await vcsCliTools(await repo({}, stubRun({})));
		expect(r.numerator).toBe(0);
		expect(r.rationale).toContain("neither gh nor glab");
	});

	test("fails when a CLI is present but unauthenticated", async () => {
		const r = await vcsCliTools(await repo({}, stubRun({ "gh auth": exit(1) })));
		expect(r.numerator).toBe(0);
		expect(r.rationale).toContain("not authenticated");
	});
});

describe("monorepoTooling", () => {
	test("passes on a workspace config file", async () => {
		expect(
			(await monorepoTooling(await repo({ "pnpm-workspace.yaml": "packages:\n" }))).numerator,
		).toBe(1);
	});

	test("passes on package.json workspaces", async () => {
		expect(
			(await monorepoTooling(await repo({ "package.json": '{"workspaces":["a"]}' }))).numerator,
		).toBe(1);
	});

	test("passes on a Cargo [workspace]", async () => {
		expect(
			(await monorepoTooling(await repo({ "Cargo.toml": "[workspace]\nmembers=[]" }))).numerator,
		).toBe(1);
	});

	test("not-applicable for a single-package repo", async () => {
		const r = await monorepoTooling(await repo({ "package.json": "{}" }));
		expect(r.naKind).toBe("not-applicable");
	});
});

describe("dependencyUpdateAutomation", () => {
	test("passes with dependabot config", async () => {
		expect(
			(await dependencyUpdateAutomation(await repo({ ".github/dependabot.yml": "version: 2" })))
				.numerator,
		).toBe(1);
	});

	test("fails without any bot config", async () => {
		expect((await dependencyUpdateAutomation(await repo({}))).numerator).toBe(0);
	});
});

describe("releaseNotesAutomation", () => {
	test("passes with a changesets config", async () => {
		expect(
			(await releaseNotesAutomation(await repo({ ".changeset/config.json": "{}" }))).numerator,
		).toBe(1);
	});

	test("passes via a semantic-release dependency", async () => {
		expect(
			(
				await releaseNotesAutomation(
					await repo({ "package.json": '{"devDependencies":{"semantic-release":"1"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("passes via a workflow that builds release notes", async () => {
		expect(
			(
				await releaseNotesAutomation(
					await repo({ ".github/workflows/r.yml": "run: release-please" }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails with only a manually-maintained CHANGELOG", async () => {
		expect(
			(await releaseNotesAutomation(await repo({ "CHANGELOG.md": "# changes" }))).numerator,
		).toBe(0);
	});
});

describe("releaseAutomation", () => {
	test("passes with a publish workflow file", async () => {
		expect(
			(await releaseAutomation(await repo({ ".github/workflows/publish.yml": "name: pub" })))
				.numerator,
		).toBe(1);
	});

	test("passes with an npm publish step in CI", async () => {
		expect(
			(await releaseAutomation(await repo({ ".github/workflows/ci.yml": "run: npm publish" })))
				.numerator,
		).toBe(1);
	});

	test("fails without a release/deploy pipeline", async () => {
		expect(
			(await releaseAutomation(await repo({ ".github/workflows/ci.yml": "run: bun test" })))
				.numerator,
		).toBe(0);
	});
});

describe("versionDriftDetection", () => {
	test("passes with syncpack config", async () => {
		expect((await versionDriftDetection(await repo({ ".syncpackrc": "{}" }))).numerator).toBe(1);
	});

	test("passes via a version-sync script", async () => {
		expect(
			(
				await versionDriftDetection(
					await repo({ "package.json": '{"scripts":{"version:check":"x"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable for a single-version repo", async () => {
		expect((await versionDriftDetection(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("deadFeatureFlagDetection", () => {
	test("passes via a stale-flag script", async () => {
		expect(
			(
				await deadFeatureFlagDetection(
					await repo({ "package.json": '{"scripts":{"flags:lint":"x"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable when no tooling exists", async () => {
		expect((await deadFeatureFlagDetection(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("featureFlagInfrastructure", () => {
	test("passes via a feature-flag SDK dependency", async () => {
		expect(
			(
				await featureFlagInfrastructure(
					await repo({ "package.json": '{"dependencies":{"unleash-client":"5"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) when none is configured", async () => {
		const r = await featureFlagInfrastructure(await repo({ "package.json": "{}" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("fastCiFeedback", () => {
	test("passes on a declared fast-feedback timeout bound", async () => {
		expect(
			(
				await fastCiFeedback(
					await repo({ ".github/workflows/ci.yml": "jobs:\n  t:\n    timeout-minutes: 8" }),
				)
			).numerator,
		).toBe(1);
	});

	test("no-detector when CI exists but no static bound (needs run history)", async () => {
		const r = await fastCiFeedback(await repo({ ".github/workflows/ci.yml": "jobs: {}" }));
		expect(r.naKind).toBe("no-detector");
	});

	test("not-applicable when there is no CI", async () => {
		expect((await fastCiFeedback(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("buildPerformanceTracking", () => {
	test("passes via a reporting script", async () => {
		expect(
			(
				await buildPerformanceTracking(
					await repo({ "package.json": '{"scripts":{"report:test-timing":"x"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("passes via CI caching", async () => {
		expect(
			(
				await buildPerformanceTracking(
					await repo({ ".github/workflows/ci.yml": "uses: actions/cache@v4" }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable when no tracking exists", async () => {
		expect((await buildPerformanceTracking(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("deploymentFrequency", () => {
	test("no-detector when deploy automation exists (needs history)", async () => {
		const r = await deploymentFrequency(
			await repo({ ".github/workflows/deploy.yml": "run: deploy" }),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("not-applicable with no CD pipeline", async () => {
		expect((await deploymentFrequency(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("progressiveRollout", () => {
	test("passes on a canary workflow", async () => {
		expect(
			(await progressiveRollout(await repo({ ".github/workflows/cd.yml": "strategy: canary" })))
				.numerator,
		).toBe(1);
	});

	test("not-applicable without rollout config", async () => {
		expect((await progressiveRollout(await repo({}))).naKind).toBe("not-applicable");
	});
});

describe("rollbackAutomation", () => {
	test("passes on a rollback workflow", async () => {
		expect(
			(await rollbackAutomation(await repo({ ".github/workflows/rollback.yml": "x" }))).numerator,
		).toBe(1);
	});

	test("passes on a rollback script", async () => {
		expect(
			(await rollbackAutomation(await repo({ "package.json": '{"scripts":{"rollback":"x"}}' })))
				.numerator,
		).toBe(1);
	});

	test("not-applicable without any rollback path", async () => {
		expect((await rollbackAutomation(await repo({}))).naKind).toBe("not-applicable");
	});
});
