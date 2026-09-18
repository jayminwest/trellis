/** Scoped native function identity v1 (SPEC §6.2; docs/hotspot-identity.md). */
import { z } from "zod";
import { SOURCE_SETS } from "./coverage.ts";

export const HOTSPOT_IDENTITY_VERSION = "1.0.0";

export const identityFunctionKindSchema = z.enum([
	"function-declaration",
	"function-expression",
	"arrow-function",
	"method",
	"constructor",
	"get-accessor",
	"set-accessor",
]);

/** Named ancestry only; unnamed/block ancestry makes the whole identity ambiguous. */
export const identityScopeSchema = z.strictObject({
	kind: z.enum(["class", "object", "namespace", ...identityFunctionKindSchema.options]),
	name: z.string().min(1),
	member: z.enum(["none", "static", "instance"]),
});

export const hotspotIdentitySchema = z.discriminatedUnion("state", [
	z.strictObject({
		version: z.literal(HOTSPOT_IDENTITY_VERSION),
		state: z.literal("identified"),
		sourceSet: z.enum(SOURCE_SETS),
		scopes: z.array(identityScopeSchema),
		function: z.strictObject({
			kind: identityFunctionKindSchema,
			name: z.string().min(1),
			member: z.enum(["none", "static", "instance"]),
		}),
	}),
	z.strictObject({
		version: z.literal(HOTSPOT_IDENTITY_VERSION),
		state: z.literal("ambiguous"),
		reason: z.enum(["anonymous", "computed-name", "unnamed-scope", "block-scope", "duplicate"]),
	}),
]);

export type HotspotIdentity = z.infer<typeof hotspotIdentitySchema>;
export type IdentityScope = z.infer<typeof identityScopeSchema>;
