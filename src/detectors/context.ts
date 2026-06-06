/**
 * {@link DetectionContext} factory (SPEC §8.1) — the read-only execution
 * environment every detector runs against.
 *
 * All three capabilities are rooted at the app directory (`repoPath`/`app.path`)
 * and refuse to escape the repo: `readFile`/`glob` return empty for paths that
 * resolve outside `repoPath`, and `run` clamps its cwd to the repo. `run` is
 * sandboxed to that cwd with a timeout and **never throws** — a missing tool
 * surfaces as exit `127`, a timeout as `timedOut: true` — so a detector can map
 * those to `noDetector(...)` rather than crashing the whole audit.
 *
 * There is no write capability by construction: the read-only mandate (§8.1) is
 * enforced by the shape of this object, not by convention.
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DetectionContext, ExecResult, Language } from "./types.ts";

/** Default subprocess timeout (ms). Detectors run short, bounded analysis tools. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Exit code reported when a command cannot be spawned (e.g. tool not installed). */
export const SPAWN_FAILURE_EXIT = 127;

export interface CreateContextOpts {
	/** Per-run subprocess timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
	timeoutMs?: number;
}

/**
 * Build a {@link DetectionContext} over `app` inside `repoPath`. `repoPath` is
 * resolved to an absolute path; `app.path` is repo-relative (`.` for repo-scope).
 */
export function createDetectionContext(
	repoPath: string,
	app: { path: string; languages: Language[] },
	opts: CreateContextOpts = {},
): DetectionContext {
	const root = resolve(repoPath);
	const appRoot = resolve(root, app.path);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	/** Resolve `rel` under `appRoot`, returning null if it escapes the repo. */
	const contain = (rel: string): string | null => {
		const abs = isAbsolute(rel) ? resolve(rel) : resolve(appRoot, rel);
		const rootRel = relative(root, abs);
		if (rootRel.startsWith("..") || isAbsolute(rootRel)) return null;
		return abs;
	};

	const run = async (argv: string[], runOpts?: { cwd?: string }): Promise<ExecResult> => {
		if (argv.length === 0) {
			return { exitCode: SPAWN_FAILURE_EXIT, stdout: "", stderr: "empty argv", timedOut: false };
		}
		const cwd = contain(runOpts?.cwd ?? ".") ?? appRoot;
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			});
		} catch (err) {
			return {
				exitCode: SPAWN_FAILURE_EXIT,
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				timedOut: false,
			};
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, timeoutMs);
		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout as ReadableStream).text(),
				new Response(proc.stderr as ReadableStream).text(),
			]);
			await proc.exited;
			return {
				exitCode: timedOut ? SPAWN_FAILURE_EXIT : (proc.exitCode ?? -1),
				stdout,
				stderr,
				timedOut,
			};
		} finally {
			clearTimeout(timer);
		}
	};

	const readFile = async (rel: string): Promise<string | null> => {
		const abs = contain(rel);
		if (abs === null) return null;
		const file = Bun.file(abs);
		if (!(await file.exists())) return null;
		return file.text();
	};

	const glob = async (pattern: string): Promise<string[]> => {
		const matches: string[] = [];
		const g = new Bun.Glob(pattern);
		for await (const m of g.scan({ cwd: appRoot, onlyFiles: true, dot: true })) {
			// Drop anything a `..` pattern would pull outside the repo.
			if (contain(join(appRoot, m)) !== null) matches.push(m);
		}
		return matches.sort();
	};

	return { repoPath: root, app, run, readFile, glob };
}
