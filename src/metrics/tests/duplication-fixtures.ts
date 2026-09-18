/** Frozen controls for the native replacement; token collection remains production code. */
import type { SourceSet } from "../../contract/index.ts";
import { collectFunctions } from "../../syntax/functions.ts";
import { parseSource } from "../../syntax/parse.ts";
import { countLines } from "../../syntax/sloc.ts";
import type { FileSyntax } from "../../syntax/types.ts";
import { collectTokenStream, type TokenStream } from "../duplication.ts";

/** Exact generator from trellis-3577's Fallow spike: 229 tokens, 27 code lines per copy. */
export function repeatedSource(name: string): string {
	return `export function ${name}(x: number) {\n${Array.from({ length: 24 }, (_, i) => ` if (x === ${i}) return ${i + 1};`).join("\n")}\n return x;\n}\n`;
}

export function sourceFile(
	path: string,
	text: string,
	sourceSet: SourceSet = "production",
): FileSyntax {
	const parsed = parseSource(path, text);
	return {
		path,
		packagePath: ".",
		sourceSet,
		...parsed,
		...collectFunctions(parsed.sourceFile),
		lines: countLines(parsed.sourceFile),
	};
}

export function repeatedStreams(count: number): TokenStream[] {
	return Array.from({ length: count }, (_, i) =>
		collectTokenStream(sourceFile(`f${i}.ts`, repeatedSource(`fn${i}`))),
	);
}

/** Every token occupies one of exactly `lines` lines; custom kind arrays isolate match semantics. */
export function syntheticStream(path: string, kinds: number[], lines = 3): TokenStream {
	const positions = kinds.map((_, i) => Math.floor((i * lines) / kinds.length) + 1);
	return {
		path,
		packagePath: ".",
		sourceSet: "production",
		kinds,
		startLines: positions,
		endLines: [...positions],
	};
}
