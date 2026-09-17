/**
 * Safeguard configuration inspection (SPEC §5.5, trellis-a97d) — non-scoring.
 *
 * Inspects Git pre-commit hooks, the supported agent hook surface (Claude
 * Code settings), lint/typecheck/test scripts, and coverage / file-size /
 * duplication budgets as **configuration only**, reporting each at an
 * explicit evidence level (`absent` | `configured` | `structurally-wired` |
 * `unknown`). Passing execution is never inferred; unsupported shell
 * constructs and executable configuration stay explicitly unverified; broken
 * local hook/check references produce located findings. Safeguard results
 * never enter the sloppiness index (§3.2, §5.5).
 *
 * The supported formats are documented in `types.ts`; the audit core
 * (trellis-ef85) assembles the results into the §6.3 report panel.
 */
export { inspectSafeguards, SAFEGUARD_IDS, type SafeguardInspection } from "./inspect.ts";
export {
	type CheckKind,
	extractLocalPaths,
	extractRunReferences,
	recognizeCheck,
} from "./shell.ts";
export { BROKEN_REFERENCE_KIND } from "./wiring.ts";
