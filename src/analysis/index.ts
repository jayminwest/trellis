/**
 * Internal analysis interfaces over the versioned provider contracts
 * (SPEC §16, trellis-90d6).
 *
 * Contracts (zod schemas + types) live in `src/contract/`; this module holds
 * the typed internal products and result interfaces that producers and
 * downstream native analyzers use in-process, plus the native capability
 * registry and the wrapped native analyzers (trellis-cb51).
 */
export * from "./native.ts";
export * from "./provenance.ts";
export * from "./registry.ts";
export * from "./result.ts";
