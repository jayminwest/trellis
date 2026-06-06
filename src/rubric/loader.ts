/**
 * Rubric loader (SPEC §6.1).
 *
 * Parses `categories.yaml`, `repo-scope.yaml`, and `app-scope.yaml` into a
 * validated {@link Rubric} and enforces the load-time invariants. Every
 * violation throws a {@link RubricError} naming the offending id and source
 * file, so authoring mistakes fail loudly and locatably.
 *
 * Load-time invariants:
 *   1. each record matches its schema (§6.1 shapes; weight > 0; investigation
 *      non-null IFF discoveryVia=agent — enforced in schema.ts);
 *   2. every criterion's `scope` matches its source file
 *      (repo-scope.yaml → repo, app-scope.yaml → app);
 *   3. ids are unique across all categories and across all criteria;
 *   4. every criterion's `category` resolves to a known category;
 *   5. exactly one `gate: true` criterion per category.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { z } from "zod";
import {
	type CategoryRecord,
	type CriterionRecord,
	categoryRecordSchema,
	criterionRecordSchema,
	type Scope,
} from "./schema.ts";

/** A validated rubric: categories plus the criteria from both scope files. */
export interface Rubric {
	categories: CategoryRecord[];
	criteria: CriterionRecord[];
}

/** Source filenames the loader reads from a rubric directory. */
const CATEGORIES_FILE = "categories.yaml";
const REPO_SCOPE_FILE = "repo-scope.yaml";
const APP_SCOPE_FILE = "app-scope.yaml";

/** An invariant violation, carrying the offending id and source file. */
export class RubricError extends Error {
	override readonly name = "RubricError";
	readonly id: string;
	readonly file: string;

	constructor(message: string, id: string, file: string) {
		super(`${file} [${id}]: ${message}`);
		this.id = id;
		this.file = file;
	}
}

/**
 * Load and validate the rubric from `dir` (defaults to this module's directory,
 * where the authored YAML lives). Throws {@link RubricError} on any invariant
 * violation.
 */
export function loadRubric(dir: string = import.meta.dir): Rubric {
	const categories = parseRecords(
		read(dir, CATEGORIES_FILE),
		CATEGORIES_FILE,
		categoryRecordSchema,
	);
	const repoCriteria = parseRecords(
		read(dir, REPO_SCOPE_FILE),
		REPO_SCOPE_FILE,
		criterionRecordSchema,
	);
	const appCriteria = parseRecords(
		read(dir, APP_SCOPE_FILE),
		APP_SCOPE_FILE,
		criterionRecordSchema,
	);

	requireScope(repoCriteria, "repo", REPO_SCOPE_FILE);
	requireScope(appCriteria, "app", APP_SCOPE_FILE);

	const criteria = [...repoCriteria, ...appCriteria];
	requireUniqueIds(categories, CATEGORIES_FILE);
	requireUniqueCriterionIds(repoCriteria, appCriteria);
	requireCategoriesResolve(categories, repoCriteria, REPO_SCOPE_FILE);
	requireCategoriesResolve(categories, appCriteria, APP_SCOPE_FILE);
	requireOneGatePerCategory(categories, criteria);

	return { categories, criteria };
}

function read(dir: string, file: string): string {
	try {
		return readFileSync(join(dir, file), "utf8");
	} catch {
		throw new RubricError("source file not found or unreadable", "<file>", file);
	}
}

/** Parse a YAML sequence of records, validating each against `schema`. */
function parseRecords<T>(text: string, file: string, schema: z.ZodType<T>): T[] {
	const doc = yaml.load(text);
	if (!Array.isArray(doc)) {
		throw new RubricError("expected a YAML sequence of records", "<root>", file);
	}
	return doc.map((entry, index) => {
		const result = schema.safeParse(entry);
		if (!result.success) {
			const id = idOf(entry, index);
			const reason = result.error.issues
				.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ");
			throw new RubricError(reason, id, file);
		}
		return result.data;
	});
}

/** Best-effort id for error messages when a record fails schema validation. */
function idOf(entry: unknown, index: number): string {
	if (entry && typeof entry === "object" && "id" in entry) {
		const { id } = entry as { id: unknown };
		if (typeof id === "string" && id.length > 0) return id;
	}
	return `index ${index}`;
}

/** Invariant 2: every criterion's scope matches its source file. */
function requireScope(criteria: CriterionRecord[], scope: Scope, file: string): void {
	for (const c of criteria) {
		if (c.scope !== scope) {
			throw new RubricError(
				`scope '${c.scope}' does not match source file (expected '${scope}')`,
				c.id,
				file,
			);
		}
	}
}

/** Invariant 3 (categories): ids unique within categories.yaml. */
function requireUniqueIds(categories: CategoryRecord[], file: string): void {
	const seen = new Set<string>();
	for (const c of categories) {
		if (seen.has(c.id)) {
			throw new RubricError("duplicate category id", c.id, file);
		}
		seen.add(c.id);
	}
}

/** Invariant 3 (criteria): ids unique across both scope files. */
function requireUniqueCriterionIds(
	repoCriteria: CriterionRecord[],
	appCriteria: CriterionRecord[],
): void {
	const seen = new Map<string, string>();
	for (const [criteria, file] of [
		[repoCriteria, REPO_SCOPE_FILE],
		[appCriteria, APP_SCOPE_FILE],
	] as const) {
		for (const c of criteria) {
			const prior = seen.get(c.id);
			if (prior) {
				throw new RubricError(`duplicate criterion id (also in ${prior})`, c.id, file);
			}
			seen.set(c.id, file);
		}
	}
}

/** Invariant 4: every criterion's category resolves to a known category. */
function requireCategoriesResolve(
	categories: CategoryRecord[],
	criteria: CriterionRecord[],
	file: string,
): void {
	const known = new Set(categories.map((c) => c.id));
	for (const c of criteria) {
		if (!known.has(c.category)) {
			throw new RubricError(`unknown category '${c.category}'`, c.id, file);
		}
	}
}

/** Invariant 5: exactly one gate:true criterion per category. */
function requireOneGatePerCategory(
	categories: CategoryRecord[],
	criteria: CriterionRecord[],
): void {
	const gatesByCategory = new Map<string, string[]>();
	for (const c of criteria) {
		if (c.gate) {
			const ids = gatesByCategory.get(c.category) ?? [];
			ids.push(c.id);
			gatesByCategory.set(c.category, ids);
		}
	}
	for (const category of categories) {
		const gates = gatesByCategory.get(category.id) ?? [];
		if (gates.length === 0) {
			throw new RubricError("category has no gate:true criterion", category.id, CATEGORIES_FILE);
		}
		if (gates.length > 1) {
			throw new RubricError(
				`category has ${gates.length} gate:true criteria (${gates.join(", ")}); expected exactly one`,
				category.id,
				CATEGORIES_FILE,
			);
		}
	}
}
