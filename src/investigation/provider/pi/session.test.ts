import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	errorTurn,
	type FakeTurn,
	invalidThenEndTurn,
	makeFakePi,
	noSubmissionTurn,
	submitFindingsTurn,
} from "./fake-pi.ts";
import { formatZodIssues, type PiSessionConfig, promptCommand, runPiSession } from "./session.ts";

const schema = z.strictObject({ value: z.number() });

function config(
	fake: ReturnType<typeof makeFakePi>,
	overrides: Partial<PiSessionConfig> = {},
): PiSessionConfig {
	return {
		argv: ["pi", "--mode", "rpc"],
		env: { PATH: "/bin" },
		cwd: "/repo",
		promptMessage: "begin",
		schema,
		maxRetries: 2,
		heartbeatMs: 5_000,
		spawn: fake.spawn,
		...overrides,
	};
}

describe("promptCommand", () => {
	test("encodes a single newline-terminated Pi prompt command", () => {
		expect(promptCommand("hello")).toBe('{"type":"prompt","message":"hello"}\n');
	});
});

describe("formatZodIssues", () => {
	test("renders a compact path: message list", () => {
		const result = schema.safeParse({ value: "x" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const formatted = formatZodIssues(result.error);
			expect(formatted).toContain("value");
		}
	});
});

describe("runPiSession", () => {
	test("captures and validates findings from the first submit_findings call", async () => {
		const fake = makeFakePi([submitFindingsTurn({ value: 1 })]);
		const outcome = await runPiSession(config(fake));
		expect(outcome).toEqual({ ok: true, findings: { value: 1 } });
		// Only the initial prompt was written; stdin was held open then closed on capture.
		expect(fake.writes).toHaveLength(1);
		expect(fake.writes[0]).toBe(promptCommand("begin"));
	});

	test("sends a corrective prompt echoing zod errors, then accepts the retry", async () => {
		const fake = makeFakePi([
			invalidThenEndTurn({ value: "nan" }),
			submitFindingsTurn({ value: 2 }),
		]);
		const outcome = await runPiSession(config(fake));
		expect(outcome).toEqual({ ok: true, findings: { value: 2 } });
		expect(fake.writes).toHaveLength(2);
		expect(fake.writes[1]).toContain("did not match the schema");
		expect(fake.writes[1]).toContain("value");
	});

	test("re-prompts when no submit_findings call is made, bounded to maxRetries", async () => {
		const fake = makeFakePi([noSubmissionTurn, noSubmissionTurn, noSubmissionTurn]);
		const outcome = await runPiSession(config(fake));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("no submit_findings call after 2 retries");
		// initial + 2 correctives = 3 writes
		expect(fake.writes).toHaveLength(3);
		expect(fake.writes[1]).toContain("did not call submit_findings");
	});

	test("exhausting retries on invalid findings resolves no-detector with the zod reason", async () => {
		const bad: FakeTurn = invalidThenEndTurn({ value: "nan" });
		const fake = makeFakePi([bad, bad, bad]);
		const outcome = await runPiSession(config(fake));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("findings invalid after 2 retries");
			expect(outcome.reason).toContain("value");
		}
	});

	test("a stopReason:error turn resolves no-detector immediately (never a pass)", async () => {
		const fake = makeFakePi([errorTurn]);
		const outcome = await runPiSession(config(fake));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("stopReason:error");
		expect(fake.writes).toHaveLength(1); // no corrective on a hard error
	});

	test("a stalled run is force-terminated by the heartbeat watchdog", async () => {
		const fake = makeFakePi([]); // initial prompt releases no turn → silence
		const outcome = await runPiSession(config(fake, { heartbeatMs: 30 }));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("heartbeat");
	});

	test("a process that exits without findings resolves no-detector", async () => {
		const fake = makeFakePi([], { exitOnWrite: { nth: 1, code: 1 } });
		const outcome = await runPiSession(config(fake));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("exited (code 1)");
	});

	test("maxRetries:0 gives up after the first run with no submission", async () => {
		const fake = makeFakePi([noSubmissionTurn]);
		const outcome = await runPiSession(config(fake, { maxRetries: 0 }));
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("after 0 retries");
		expect(fake.writes).toHaveLength(1);
	});
});
