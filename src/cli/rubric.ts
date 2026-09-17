/** Actionable retirement error for the old public readiness catalog (SPEC §12). */
import type { Command } from "commander";
import { retiredReadinessMessage } from "../legacy.ts";
import { CliError } from "./output.ts";

export function registerRubric(program: Command): void {
	program
		.command("rubric", { hidden: true })
		.allowUnknownOption()
		.allowExcessArguments()
		.action(() => {
			throw new CliError(retiredReadinessMessage("trellis rubric"));
		});
}
