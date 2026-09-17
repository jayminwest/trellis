import { describe, expect, test } from "bun:test";
import { CliError, EXIT } from "./output.ts";
import { providerSelectionFromFlags } from "./provider-flags.ts";

/**
 * `--provider` flag translation (SPEC §16.4, plan `pl-43c5` step 18 —
 * trellis-5ee9). Pure data shaping: valid selections fold into exactly the
 * declarative `providers` block the core accepts, and every bad selection
 * is an actionable operational {@link CliError} (exit 1, SPEC §16.3) —
 * never a silently ignored or reinterpreted value. The CLI integration
 * suite (`audit-providers.test.ts`) exercises the same translation through
 * real CLI subprocesses; these unit tests pin every rejection branch.
 */

describe("providerSelectionFromFlags", () => {
	test("translates valid selections into the core providers block", () => {
		expect(providerSelectionFromFlags(["jscpd:exact"])).toEqual({ jscpd: { mode: "exact" } });
		expect(providerSelectionFromFlags(["jscpd:near"])).toEqual({ jscpd: { mode: "near" } });
		expect(providerSelectionFromFlags(["knip"])).toEqual({ knip: {} });
		expect(providerSelectionFromFlags(["sonarjs"])).toEqual({ sonarjs: {} });
		expect(providerSelectionFromFlags(["dependency-cruiser"])).toEqual({
			"dependency-cruiser": {},
		});
		expect(providerSelectionFromFlags(["sonarjs", "jscpd:normalized", "knip"])).toEqual({
			jscpd: { mode: "normalized" },
			knip: {},
			sonarjs: {},
		});
	});

	function expectOperationalError(selections: string[], fragment: string): void {
		try {
			providerSelectionFromFlags(selections);
			throw new Error(`expected selections ${JSON.stringify(selections)} to fail`);
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			const cliError = error as CliError;
			expect(cliError.code).toBe(EXIT.ERROR);
			expect(cliError.message).toContain(fragment);
		}
	}

	test("rejects unknown and empty selections actionably", () => {
		expectOperationalError([""], "--provider needs a provider id");
		expectOperationalError(["foo"], 'unknown provider "foo"');
		// The supported vocabulary rides in the message, so it stays actionable.
		try {
			providerSelectionFromFlags(["foo"]);
			throw new Error("unreachable");
		} catch (error) {
			expect((error as CliError).message).toContain(
				"supported optional providers are dependency-cruiser, jscpd, knip, sonarjs",
			);
		}
	});

	test("rejects a missing or unknown jscpd match mode", () => {
		expectOperationalError(["jscpd"], 'provider "jscpd" needs a match mode');
		expectOperationalError(["jscpd:"], 'unknown jscpd match mode ""');
		expectOperationalError(["jscpd:fuzzy"], 'unknown jscpd match mode "fuzzy"');
	});

	test("rejects duplicate and conflicting selections", () => {
		expectOperationalError(["knip", "knip"], 'provider "knip" is selected more than once');
		expectOperationalError(
			["jscpd:exact", "jscpd:exact"],
			'provider "jscpd" is selected more than once',
		);
		expectOperationalError(
			["jscpd:exact", "jscpd:near"],
			'conflicting --provider selections for "jscpd"',
		);
	});

	test("rejects options on providers with no delivered adapter", () => {
		expectOperationalError(["sonarjs:rules"], 'provider "sonarjs" takes no selection options yet');
	});
});
