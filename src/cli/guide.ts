import type { Command } from "commander";
import { GuideError, getGuide } from "../guides/index.ts";
import { CliError, emit, resolveFormat } from "./output.ts";

/** Thin rendering surface over the canonical, read-only core guides. */
export function registerGuide(program: Command): void {
	program
		.command("guide")
		.argument("<name>", "guide name (cleanup)")
		.description("read bundled task guidance: trellis guide cleanup")
		.action(function (this: Command, name: string) {
			const format = resolveFormat(this.optsWithGlobals());
			try {
				const guide = getGuide(name);
				emit(format, { human: guide.content, md: guide.content, json: guide });
			} catch (error) {
				if (error instanceof GuideError) throw new CliError(error.message);
				throw error;
			}
		});
}
