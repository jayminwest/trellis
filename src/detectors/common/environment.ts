/**
 * Environment & Setup detectors (SPEC §5.4) — the language-agnostic subset:
 * `env_template`, `gitignore_comprehensive`, `deps_pinned`, `devcontainer`.
 *
 * All four are **non-skippable**, so they obey the §3.2 floor: present → pass,
 * absent → **fail** (never N/A). Each rationale names the concrete evidence
 * path so a reader can reproduce the verdict.
 */
import { type Detector, fail, pass } from "../types.ts";
import { firstHit, globHits } from "./util.ts";

/** Committed `.env`-style example files (no real secrets), checked at the app root. */
const ENV_TEMPLATE_PATTERNS = [
	".env.example",
	".env.sample",
	".env.template",
	".env.dist",
	".env.local.example",
	"env.example",
	".env.*.example",
	"config/.env.example",
];

/** Committed lockfiles across ecosystems — the strong signal for pinned deps. */
const LOCKFILES = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
	"Package.resolved",
	"gradle.lockfile",
];

/** Dev-container config locations (presence only, per §5.4). */
const DEVCONTAINER_PATTERNS = [
	".devcontainer.json",
	".devcontainer/devcontainer.json",
	".devcontainer/*/devcontainer.json",
];

/** Minimum meaningful (non-comment, non-blank) `.gitignore` lines to count as comprehensive. */
export const GITIGNORE_MIN_PATTERNS = 5;

/** `env_template` (R/L1): a committed `.env`-style example exists. */
export const envTemplate: Detector = async (ctx) => {
	const hit = await firstHit(ctx, ENV_TEMPLATE_PATTERNS);
	return hit !== null
		? pass(`committed env template at '${hit}'`)
		: fail("no committed .env-style template (.env.example/.sample/.template) found");
};

/** `gitignore_comprehensive` (R/L1): a `.gitignore` with enough real patterns. */
export const gitignoreComprehensive: Detector = async (ctx) => {
	const text = await ctx.readFile(".gitignore");
	if (text === null) return fail("no .gitignore at the app root");
	const patterns = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	return patterns.length >= GITIGNORE_MIN_PATTERNS
		? pass(`.gitignore has ${patterns.length} ignore patterns (>= ${GITIGNORE_MIN_PATTERNS})`)
		: fail(
				`.gitignore has only ${patterns.length} ignore patterns (< ${GITIGNORE_MIN_PATTERNS}); not comprehensive`,
			);
};

/** `deps_pinned` (R/L2, gate): a committed lockfile pins dependency versions. */
export const depsPinned: Detector = async (ctx) => {
	const hits = await globHits(ctx, LOCKFILES);
	return hits.length > 0
		? pass(`committed lockfile(s) pin versions: ${hits.join(", ")}`)
		: fail(`no committed lockfile (looked for ${LOCKFILES.slice(0, 5).join(", ")}, …)`);
};

/** `devcontainer` (R/L2): a dev-container config is committed (presence only). */
export const devcontainer: Detector = async (ctx) => {
	const hit = await firstHit(ctx, DEVCONTAINER_PATTERNS);
	return hit !== null
		? pass(`dev-container config committed at '${hit}'`)
		: fail("no .devcontainer/devcontainer.json (or .devcontainer.json) committed");
};
