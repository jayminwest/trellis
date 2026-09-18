import { CLEANUP_GUIDE } from "./cleanup.ts";

export const GUIDE_NAMES = ["cleanup"] as const;

export interface Guide {
	readonly name: (typeof GUIDE_NAMES)[number];
	readonly content: string;
}

export class GuideError extends Error {
	override readonly name = "GuideError";
}

/** Return bundled instructions without reading a workspace or executing commands. */
export function getGuide(name: string): Guide {
	if (name !== "cleanup") {
		throw new GuideError(`Unknown guide. Supported guides: ${GUIDE_NAMES.join(", ")}.`);
	}
	return { name, content: CLEANUP_GUIDE };
}
