/** TypeScript/TSX source discovery and classification. */
export {
	type Classification,
	classifyTsFile,
	isTypeScriptSource,
	isUnsupportedSource,
	UNSUPPORTED_SOURCE_EXTENSIONS,
} from "./classify.ts";
export { matchAnyGlob, matchGlob } from "./glob.ts";
export {
	type ClassifiedFile,
	type DiscoverInventoryOptions,
	discoverSourceInventory,
	type ExcludedFile,
	type IgnoredEntry,
	type IgnoredReason,
	type SourceInventory,
	toSourceCoverage,
	type WorkspacePackage,
} from "./inventory.ts";
