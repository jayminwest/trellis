import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AllowedDelta,
	DriftError,
	driftRepo,
	type FileDrift,
	loadManifest,
	readCanonical,
	resolveCanonicalVersion,
} from "./index.ts";

/** The bundled manifest, loaded once for fixture construction. */
const MANIFEST = loadManifest();

/** Write `content` at `rel` under `root`, creating parent dirs. */
function writeAt(root: string, rel: string, content: string | Buffer): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

/** Seed a fresh temp repo whose files are the exact canonical bytes (a clean repo). */
function cleanRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "trellis-drift-"));
	for (const file of MANIFEST.files) writeAt(root, file.path, readCanonical(file.path));
	return root;
}

/** The {@link FileDrift} for `path` in a drift run over `root`. */
function fileState(root: string, path: string, allowedDeltas?: AllowedDelta[]): FileDrift {
	const report = driftRepo(root, allowedDeltas ? { allowedDeltas } : {});
	const file = report.files.find((f) => f.path === path);
	if (!file) throw new Error(`no drift result for ${path}`);
	return file;
}

/** Run `fn` against a fresh clean repo, always cleaning up the temp dir. */
function withRepo(fn: (root: string) => void): void {
	const root = cleanRepo();
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("driftRepo (clean repo)", () => {
	test("every canonical file matches when the repo is a verbatim copy", () => {
		withRepo((root) => {
			const report = driftRepo(root);
			const drifted = report.files.filter((f) => f.state !== "match");
			expect(drifted).toEqual([]);
			expect(report.summary.match).toBe(MANIFEST.files.length);
		});
	});

	test("reports the resolved canonical version and repo basename", () => {
		withRepo((root) => {
			const report = driftRepo(root);
			expect(report.canonicalVersion).toBe(MANIFEST.version);
			expect(report.repo.length).toBeGreaterThan(0);
		});
	});

	test("summary counts sum to the number of canonical files", () => {
		withRepo((root) => {
			const s = driftRepo(root).summary;
			const total = s.match + s["allowed-delta"] + s.drift + s.missing + s.extra;
			expect(total).toBe(MANIFEST.files.length);
		});
	});
});

describe("missing state", () => {
	test("a deleted canonical file reports missing", () => {
		withRepo((root) => {
			rmSync(join(root, "biome.json"));
			const file = fileState(root, "biome.json");
			expect(file.state).toBe("missing");
			expect(file.divergences).toEqual([]);
		});
	});
});

describe("exact matcher", () => {
	const hookPath = "scripts/hooks/pre-commit";

	test("a byte-identical hook matches", () => {
		withRepo((root) => {
			expect(fileState(root, hookPath).state).toBe("match");
		});
	});

	test("any byte change is drift (no subset tolerance)", () => {
		withRepo((root) => {
			writeAt(root, hookPath, `${readCanonical(hookPath).toString()}\n# local tweak\n`);
			const file = fileState(root, hookPath);
			expect(file.state).toBe("drift");
			expect(file.divergences[0]?.path).toBe("");
		});
	});

	test("a whole-file allowed delta downgrades exact drift to allowed-delta", () => {
		withRepo((root) => {
			writeAt(root, hookPath, "#!/usr/bin/env bash\necho custom\n");
			const file = fileState(root, hookPath, [{ file: hookPath, reason: "custom gate" }]);
			expect(file.state).toBe("allowed-delta");
			expect(file.allowedBy[0]?.reason).toBe("custom gate");
		});
	});
});

describe("text matcher", () => {
	const tomlPath = "bunfig.toml";

	test("whitespace-only changes still match (normalized text)", () => {
		withRepo((root) => {
			writeAt(root, tomlPath, `${readCanonical(tomlPath).toString()}   \n\n\n`);
			expect(fileState(root, tomlPath).state).toBe("match");
		});
	});

	test("a content change is drift", () => {
		withRepo((root) => {
			writeAt(root, tomlPath, "# entirely different comment\n");
			expect(fileState(root, tomlPath).state).toBe("drift");
		});
	});
});

describe("json-subset matcher", () => {
	const jsonPath = "biome.json";

	test("extra top-level keys read as extra, not drift", () => {
		withRepo((root) => {
			const canon = JSON.parse(readCanonical(jsonPath).toString());
			writeAt(root, jsonPath, JSON.stringify({ ...canon, vcs: { enabled: false } }));
			const file = fileState(root, jsonPath);
			expect(file.state).toBe("extra");
			expect(file.divergences.some((d) => d.path === "vcs" && d.kind === "added")).toBe(true);
		});
	});

	test("a changed canonical value is drift at the structural path", () => {
		withRepo((root) => {
			const canon = JSON.parse(readCanonical(jsonPath).toString());
			canon.formatter.lineWidth = 120;
			writeAt(root, jsonPath, JSON.stringify(canon));
			const file = fileState(root, jsonPath);
			expect(file.state).toBe("drift");
			expect(file.divergences.some((d) => d.path === "formatter.lineWidth")).toBe(true);
		});
	});

	test("a missing canonical key is drift", () => {
		withRepo((root) => {
			const canon = JSON.parse(readCanonical(jsonPath).toString());
			delete canon.formatter;
			writeAt(root, jsonPath, JSON.stringify(canon));
			const file = fileState(root, jsonPath);
			expect(file.state).toBe("drift");
			expect(file.divergences.some((d) => d.path === "formatter" && d.kind === "missing")).toBe(
				true,
			);
		});
	});

	test("a structural-path allowed delta whitelists exactly that path", () => {
		withRepo((root) => {
			const canon = JSON.parse(readCanonical(jsonPath).toString());
			canon.formatter.lineWidth = 120;
			writeAt(root, jsonPath, JSON.stringify(canon));
			const file = fileState(root, jsonPath, [
				{ file: jsonPath, paths: ["formatter"], reason: "wider for generated code" },
			]);
			expect(file.state).toBe("allowed-delta");
		});
	});

	test("a structural-path delta on the wrong path leaves drift", () => {
		withRepo((root) => {
			const canon = JSON.parse(readCanonical(jsonPath).toString());
			canon.formatter.lineWidth = 120;
			writeAt(root, jsonPath, JSON.stringify(canon));
			const file = fileState(root, jsonPath, [
				{ file: jsonPath, paths: ["linter"], reason: "unrelated" },
			]);
			expect(file.state).toBe("drift");
		});
	});

	test("invalid JSON in the target is whole-file drift", () => {
		withRepo((root) => {
			writeAt(root, jsonPath, "{ not json");
			const file = fileState(root, jsonPath);
			expect(file.state).toBe("drift");
			expect(file.divergences[0]?.path).toBe("");
		});
	});
});

describe("yaml-subset matcher", () => {
	const yamlPath = ".github/dependabot.yml";

	test("a verbatim YAML file matches", () => {
		withRepo((root) => {
			expect(fileState(root, yamlPath).state).toBe("match");
		});
	});

	test("a changed scalar is drift", () => {
		withRepo((root) => {
			const text = readCanonical(yamlPath).toString();
			writeAt(root, yamlPath, text.replace(/version: 2/, "version: 9"));
			// Only assert it is no longer a clean match — the path depends on the doc shape.
			expect(["drift", "extra"]).toContain(fileState(root, yamlPath).state);
		});
	});
});

describe("template matcher", () => {
	const tmplPath = "AGENTS.md";

	test("a doc with every required section matches (tokens filled in)", () => {
		withRepo((root) => {
			// The verbatim canonical AGENTS.md retains all its own headings.
			expect(["match", "extra"]).toContain(fileState(root, tmplPath).state);
		});
	});

	test("dropping a required section is drift", () => {
		withRepo((root) => {
			const text = readCanonical(tmplPath)
				.toString()
				.replace(/^## Conventions$/m, "## Renamed");
			writeAt(root, tmplPath, text);
			const file = fileState(root, tmplPath);
			expect(file.state).toBe("drift");
			expect(file.divergences.some((d) => d.path === "section:conventions")).toBe(true);
		});
	});

	test("an added section reads as extra", () => {
		withRepo((root) => {
			writeAt(root, tmplPath, `${readCanonical(tmplPath).toString()}\n## Local Extras\n\nstuff\n`);
			const file = fileState(root, tmplPath);
			expect(file.state).toBe("extra");
			expect(file.divergences.some((d) => d.path === "section:local extras")).toBe(true);
		});
	});

	test("a missing template section can be whitelisted by section path", () => {
		withRepo((root) => {
			const text = readCanonical(tmplPath)
				.toString()
				.replace(/^## Conventions$/m, "## Renamed");
			writeAt(root, tmplPath, text);
			const file = fileState(root, tmplPath, [
				{ file: tmplPath, paths: ["section:conventions"], reason: "merged into README" },
			]);
			expect(file.state).toBe("allowed-delta");
		});
	});
});

describe("resolveCanonicalVersion", () => {
	test("per-repo override wins over default and fallback", () => {
		expect(resolveCanonicalVersion("2.0.0", "1.5.0", "1.0.0")).toBe("2.0.0");
	});

	test("default is used when there is no per-repo override", () => {
		expect(resolveCanonicalVersion(undefined, "1.5.0", "1.0.0")).toBe("1.5.0");
	});

	test("fallback is used when neither override nor default is set", () => {
		expect(resolveCanonicalVersion(undefined, undefined, "1.0.0")).toBe("1.0.0");
	});
});

describe("driftRepo (version resolution)", () => {
	test("an unbundled canonical version throws DriftError", () => {
		withRepo((root) => {
			expect(() => driftRepo(root, { canonicalVersion: "9.9.9" })).toThrow(DriftError);
		});
	});

	test("requesting the bundled version succeeds", () => {
		withRepo((root) => {
			expect(driftRepo(root, { canonicalVersion: MANIFEST.version }).canonicalVersion).toBe(
				MANIFEST.version,
			);
		});
	});
});
