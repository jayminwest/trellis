/**
 * Pi extension that registers the `submit_findings` tool (SPEC §9.2).
 *
 * Pi has no JSON-schema-constrained generation, so trellis obtains structured
 * facts via a **tool call**, not by parsing free text. This module is loaded by
 * Pi via `-e <this file>` (under `--no-extensions`, which still honours explicit
 * `-e` paths). Its default export is a Pi `ExtensionFactory`: on load it reads
 * which area is being investigated from {@link AREA_ENV_VAR}, derives the tool's
 * parameter JSON-schema from that area's zod findings schema (§7.2) via zod v4's
 * native `z.toJSONSchema`, and registers a single `submit_findings` tool.
 *
 * The handler merely **acknowledges receipt** — the authoritative capture is
 * trellis reading the tool-call arguments off the RPC event stream (`./session.ts`)
 * and zod-validating them there. Setting `terminate: true` hints Pi to stop
 * after the tool batch; trellis also closes stdin on capture, so the run ends
 * either way.
 *
 * Pi is not a trellis dependency, so the extension API surface is declared here
 * as a minimal **structural** interface. At runtime Pi passes its real
 * `ExtensionAPI`, of which these types are a subset (TS/JS are structural). The
 * `parameters` field is a plain JSON-schema object — Pi's providers serialise it
 * by reading `.properties`/`.required`, so no TypeBox runtime is required.
 */

import { z } from "zod";
import { AREA_IDS, type AreaId } from "../../areas.ts";
import { FINDINGS_SCHEMAS } from "../../findings.ts";

/** The tool name the per-area run must call exactly once. */
export const SUBMIT_FINDINGS_TOOL = "submit_findings";

/** Env var through which trellis tells the extension which area's schema to register. */
export const AREA_ENV_VAR = "TRELLIS_INVESTIGATION_AREA";

/** A text/image content block returned to the model (the subset we emit). */
interface PiToolResultContent {
	readonly type: "text";
	readonly text: string;
}

/** The minimal shape of a Pi tool result our handler returns. */
interface PiToolResult {
	readonly content: PiToolResultContent[];
	readonly details: unknown;
	readonly terminate?: boolean;
}

/** The minimal Pi `ToolDefinition` shape this extension produces. */
export interface PiToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	/** JSON-schema for the tool's parameter object (derived from a zod schema). */
	readonly parameters: Record<string, unknown>;
	execute(toolCallId: string, params: unknown): Promise<PiToolResult>;
}

/** The minimal Pi `ExtensionAPI` surface this extension consumes. */
export interface PiExtensionApi {
	registerTool(tool: PiToolDefinition): void;
}

/**
 * Resolve the investigation area from `env` (the {@link AREA_ENV_VAR} value),
 * throwing on a missing/unknown id. A clear throw surfaces as a Pi
 * `extension_error`; trellis then sees no `submit_findings` and degrades the
 * area to `no-detector` rather than grading against a wrong schema.
 */
export function resolveAreaFromEnv(env: NodeJS.ProcessEnv = process.env): AreaId {
	const raw = env[AREA_ENV_VAR]?.trim();
	if (!raw) {
		throw new Error(`${AREA_ENV_VAR} is not set; cannot register submit_findings`);
	}
	if (!(AREA_IDS as readonly string[]).includes(raw)) {
		throw new Error(`${AREA_ENV_VAR}="${raw}" is not a known investigation area`);
	}
	return raw as AreaId;
}

/**
 * Build the `submit_findings` tool definition for `area`. The parameter
 * schema is the area's zod findings schema converted to JSON-schema, so Pi is
 * shown exactly the fact shape it must return (SPEC §9.2).
 */
export function submitFindingsTool(area: AreaId): PiToolDefinition {
	const parameters = z.toJSONSchema(FINDINGS_SCHEMAS[area]) as Record<string, unknown>;
	return {
		name: SUBMIT_FINDINGS_TOOL,
		label: "Submit findings",
		description:
			`Submit the objective facts gathered for the "${area}" investigation area, ` +
			"shaped to match this tool's parameter schema. Report facts, never verdicts. " +
			"Call this tool exactly once when you have gathered the facts.",
		parameters,
		async execute(_toolCallId, _params): Promise<PiToolResult> {
			// Acknowledge only — trellis captures and validates the arguments off
			// the RPC event stream. `terminate` hints Pi to stop after this batch.
			return {
				content: [{ type: "text", text: "Findings received." }],
				details: null,
				terminate: true,
			};
		},
	};
}

/** Pi `ExtensionFactory`: register `submit_findings` for the env-selected area. */
export default function activate(pi: PiExtensionApi): void {
	const area = resolveAreaFromEnv();
	pi.registerTool(submitFindingsTool(area));
}
