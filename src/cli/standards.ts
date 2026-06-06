/**
 * `trellis standards` — print the bundled canonical manifest + versions (SPEC
 * §10, §12). Thin per SPEC §13.1: it loads the manifest via the core loader and
 * shapes the three output variants (per-file path / version / matcher table),
 * computing nothing itself. The JSON variant is the manifest document verbatim,
 * so it doubles as the machine-readable canonical-set descriptor.
 */
import type { Command } from "commander";
import { loadManifest, type Manifest, ManifestError } from "../standards/index.ts";
import { CliError, EXIT, emit, type Rendered, resolveFormat } from "./output.ts";

/** Register the `standards` subcommand on `program`. */
export function registerStandards(program: Command): void {
	program
		.command("standards")
		.description("show canonical manifest + versions")
		.action(function (this: Command) {
			runStandards(this.optsWithGlobals() as { json?: boolean; md?: boolean });
		});
}

/** Load the manifest, converting a loader {@link ManifestError} into a {@link CliError}. */
function loadOrThrow(): Manifest {
	try {
		return loadManifest();
	} catch (error) {
		if (error instanceof ManifestError) throw new CliError(error.message, EXIT.ERROR);
		throw error;
	}
}

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function humanManifest(manifest: Manifest): string {
	const pathWidth = Math.max(4, ...manifest.files.map((f) => f.path.length));
	const lines = [
		`trellis standards · canonical set ${manifest.version} · ${manifest.files.length} files`,
		"",
		`  ${pad("file", pathWidth)}  ${pad("version", 7)}  matcher`,
	];
	for (const file of manifest.files) {
		lines.push(`  ${pad(file.path, pathWidth)}  ${pad(file.version, 7)}  ${file.matcher}`);
	}
	return lines.join("\n");
}

function markdownManifest(manifest: Manifest): string {
	const lines = [
		`# Canonical standards \`${manifest.version}\``,
		"",
		`**${manifest.files.length}** bundled files.`,
		"",
		"| File | Version | Matcher |",
		"| --- | --- | --- |",
	];
	for (const file of manifest.files) {
		lines.push(`| \`${file.path}\` | ${file.version} | ${file.matcher} |`);
	}
	lines.push("");
	return lines.join("\n");
}

/** Load the manifest and emit it as human text / JSON / markdown. */
function runStandards(opts: { json?: boolean; md?: boolean }): void {
	const format = resolveFormat(opts);
	const manifest = loadOrThrow();
	emit(format, {
		human: humanManifest(manifest),
		json: manifest,
		md: markdownManifest(manifest),
	} satisfies Rendered);
}
