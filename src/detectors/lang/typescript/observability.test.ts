import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext } from "../../types.ts";
import { errorTrackingContextualized, structuredLogging } from "./observability.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(pkg: Record<string, unknown>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-ts-obs-"));
	dirs.push(root);
	await writeFile(join(root, "package.json"), JSON.stringify(pkg));
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("structuredLogging", () => {
	test("passes when pino is a dependency", async () => {
		expect((await structuredLogging(await repo({ dependencies: { pino: "^10" } }))).numerator).toBe(
			1,
		);
	});

	test("passes when winston is a dependency", async () => {
		expect(
			(await structuredLogging(await repo({ dependencies: { winston: "^3" } }))).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) with no structured logger", async () => {
		const r = await structuredLogging(await repo({ dependencies: {} }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("errorTrackingContextualized", () => {
	test("passes when a Sentry SDK is a dependency", async () => {
		expect(
			(await errorTrackingContextualized(await repo({ dependencies: { "@sentry/node": "^8" } })))
				.numerator,
		).toBe(1);
	});

	test("passes via OpenTelemetry", async () => {
		expect(
			(
				await errorTrackingContextualized(
					await repo({ dependencies: { "@opentelemetry/api": "^1" } }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) with no error tracker", async () => {
		const r = await errorTrackingContextualized(await repo({ dependencies: { pino: "^10" } }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});
