/**
 * Internal analysis interfaces over the versioned provider contracts
 * (SPEC §16, trellis-90d6).
 *
 * Contracts (zod schemas + types) live in `src/contract/`; this module holds
 * the typed internal products and result interfaces that producers and
 * downstream native analyzers use in-process. The capability registry
 * (trellis-cb51) and audit orchestration (trellis-1e66) build on these.
 */
export * from "./result.ts";
