import { describe, expect, test } from "bun:test";
import type { AreaId } from "./areas.ts";
import {
	CANONICAL,
	CORRUPTED_GOLDEN_FILE,
	canonicalizePiStream,
	goldenEnvelopes,
	goldenFileName,
	loadGolden,
} from "./golden.ts";
import { type Grade, gradeArea } from "./grader.ts";
import { investigate } from "./provider/index.ts";
import { type FakeTurn, makeFakePi } from "./provider/pi/fake-pi.ts";

/**
 * The offline golden harness (SPEC §9.7). Each frozen `__golden__/<area>.jsonl`
 * is replayed through the **real** provider entrypoint — RPC parser → toolCall
 * capture → zod validation — and the validated facts run through the
 * deterministic grader, asserting the exact grade each stream produces. No `pi`
 * binary, no network, no model: a scripted fake spawn emits the recorded stream.
 */

/** Where the area is investigated; with a fake spawn the path is never read. */
const REPO = process.cwd();

/** Replay an area's frozen golden as a single Pi turn through `investigate()`. */
async function replayArea(area: AreaId, env: NodeJS.ProcessEnv = {}) {
	const turn = goldenEnvelopes(area) as unknown as FakeTurn;
	const fake = makeFakePi([turn]);
	const result = await investigate(REPO, area, { spawn: fake.spawn, sourceEnv: env });
	return { result, fake };
}

/** A {@link Grade} map as a plain object, for `toEqual` on the full area. */
function gradesObject(grades: Map<string, Grade>): Record<string, Grade> {
	return Object.fromEntries(grades);
}

/** The exact grade each frozen golden must produce (same facts → same grade). */
const EXPECTED_GRADES: Record<AreaId, Record<string, Grade>> = {
	documentation: {
		readme: {
			numerator: 1,
			denominator: 1,
			rationale: "README at repo root covering setup and usage.",
		},
		build_cmd_doc: { numerator: 1, denominator: 1, rationale: "Build command is written down." },
		automated_doc_generation: {
			numerator: 1,
			denominator: 1,
			rationale: "Doc generation: mermaid diagram render (docs/architecture.mmd).",
		},
		runbooks_documented: { numerator: 1, denominator: 1, rationale: "1 runbook(s) reachable." },
		single_command_setup: {
			numerator: 1,
			denominator: 1,
			rationale: "A single fresh-clone → running-dev-env command is documented.",
		},
		documentation_freshness: {
			numerator: 1,
			denominator: 1,
			rationale: "4/4 key doc(s) modified within 180d.",
		},
		service_flow_documented: {
			numerator: 1,
			denominator: 1,
			rationale: "Architecture/flow docs: 1 file(s).",
		},
	},
	"agent-config": {
		agents_md: {
			numerator: 1,
			denominator: 1,
			rationale:
				"Agent-instructions file AGENTS.md documents scripts, commands, conventions, and workflow.",
		},
		skills: {
			numerator: 1,
			denominator: 1,
			rationale: "1 valid skill(s) (name + description + non-empty prompt).",
		},
		agents_md_validation: {
			numerator: 1,
			denominator: 1,
			rationale: "Validation automation: ci-runs-commands, pre-commit.",
		},
		agentic_development: {
			numerator: 1,
			denominator: 1,
			rationale: "Agent instruction surface present and 14 agent co-authored commit(s).",
		},
	},
	"setup-runnability": {
		secrets_management: {
			numerator: 1,
			denominator: 1,
			rationale: "Secrets via env-file, none committed.",
		},
		local_services_setup: {
			numerator: null,
			denominator: 1,
			naKind: "not-applicable",
			rationale: "Project requires no local services.",
		},
		devcontainer_runnable: {
			numerator: null,
			denominator: 1,
			naKind: "not-applicable",
			rationale: "No devcontainer configured.",
		},
	},
	"test-layout": {
		unit_tests_exist: { numerator: 1, denominator: 1, rationale: "42 unit-test file(s) present." },
		integration_tests_exist: {
			numerator: 0,
			denominator: 1,
			rationale: "No integration tests across a real boundary.",
		},
		test_naming_conventions: {
			numerator: 1,
			denominator: 1,
			rationale: "All 42 test file(s) follow one naming convention.",
		},
		test_performance_tracking: {
			numerator: 1,
			denominator: 1,
			rationale: "A slow-test/timing surface exists.",
		},
		test_isolation: {
			numerator: 1,
			denominator: 1,
			rationale: "Tests run in parallel with no shared-mutable-state violations.",
		},
		flaky_test_detection: {
			numerator: 0,
			denominator: 1,
			rationale: "Tests present but no retry/quarantine/flaky reporting.",
		},
	},
};

const AREAS = Object.keys(EXPECTED_GRADES) as AreaId[];

describe("golden harness — parser → zod → grader, offline", () => {
	for (const area of AREAS) {
		test(`${area}: replays its frozen golden to the exact grades`, async () => {
			const { result, fake } = await replayArea(area);
			expect(result.ok).toBe(true);
			// The fake spawn was used — no real `pi` was launched.
			expect(fake.spawnCtx).toBeDefined();
			if (!result.ok) return;
			const grades = gradeArea(area, result.findings);
			expect(gradesObject(grades)).toEqual(EXPECTED_GRADES[area]);
		});
	}

	test("every golden grades identically across two consecutive runs (stability)", async () => {
		for (const area of AREAS) {
			const first = await replayArea(area);
			const second = await replayArea(area);
			if (!first.result.ok || !second.result.ok)
				throw new Error(`${area} did not produce findings`);
			expect(gradesObject(gradeArea(area, second.result.findings))).toEqual(
				gradesObject(gradeArea(area, first.result.findings)),
			);
		}
	});
});

describe("golden harness — corrupted fixture drives corrective → no-detector", () => {
	test("a verdict-shaped key is rejected; retries exhaust to an honest failure", async () => {
		const turn = loadGolden(CORRUPTED_GOLDEN_FILE);
		const corrupted = JSON.parse(`[${turn.trim().split("\n").join(",")}]`) as FakeTurn;
		// Same corrupted turn re-released for the initial prompt + 2 correctives.
		const fake = makeFakePi([corrupted, corrupted, corrupted]);
		const result = await investigate(REPO, "documentation", { spawn: fake.spawn, sourceEnv: {} });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// no-detector with the zod reason naming the smuggled key — never a pass.
		expect(result.reason).toContain("findings invalid after 2 retries");
		expect(result.reason).toContain("passed");
		// A corrective prompt was issued (initial + 2 correctives = 3 writes).
		expect(fake.writes).toHaveLength(3);
		expect(fake.writes[1]).toContain("did not match the schema");
	});
});

describe("offline guarantee — no network env required", () => {
	test("each golden replays green with provider/network env scrubbed", async () => {
		// An env with no ANTHROPIC_API_KEY / provider keys at all.
		for (const area of AREAS) {
			const { result } = await replayArea(area, {});
			expect(result.ok).toBe(true);
		}
	});
});

describe("canonicalizePiStream", () => {
	test("collapses volatile fields to fixed placeholders", () => {
		const raw = JSON.stringify({
			type: "message_end",
			sessionId: "sess-abc",
			responseId: "resp-xyz",
			timestamp: "2026-06-06T18:00:00.000Z",
			message: {
				id: "msg-1",
				usage: { inputTokens: 999, outputTokens: 42, cacheReadTokens: 7 },
				content: [
					{ type: "toolCall", id: "call-1", name: "submit_findings", arguments: { ok: 1 } },
				],
			},
			durationMs: 12345,
		});
		const canonical = canonicalizePiStream(raw);
		const parsed = JSON.parse(canonical.trim()) as Record<string, unknown>;
		expect(parsed.sessionId).toBe(CANONICAL.id);
		expect(parsed.responseId).toBe(CANONICAL.id);
		expect(parsed.timestamp).toBe(CANONICAL.timestamp);
		expect(parsed.durationMs).toBe(0);
		const message = parsed.message as Record<string, unknown>;
		expect(message.id).toBe(CANONICAL.id);
		expect(message.usage).toEqual(CANONICAL.usage);
		// Real facts (the toolCall arguments) are preserved untouched.
		const content = message.content as Array<Record<string, unknown>>;
		expect(content[0]?.arguments).toEqual({ ok: 1 });
		expect(content[0]?.id).toBe(CANONICAL.id);
	});

	test("is idempotent", () => {
		const raw = JSON.stringify({ type: "agent_start", sessionId: "x", timestamp: "t" });
		const once = canonicalizePiStream(raw);
		expect(canonicalizePiStream(once)).toBe(once);
	});

	test("throws on a non-JSON line (a malformed capture fails loudly)", () => {
		expect(() => canonicalizePiStream("not json\n")).toThrow("not valid JSON");
	});
});

describe("frozen goldens are already canonical", () => {
	for (const file of [...AREAS.map(goldenFileName), CORRUPTED_GOLDEN_FILE]) {
		test(`${file} equals its canonicalized form (clean re-record diffs)`, () => {
			const frozen = loadGolden(file);
			expect(canonicalizePiStream(frozen)).toBe(frozen);
		});
	}
});
