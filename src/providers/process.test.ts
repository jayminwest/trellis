import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ControlledProcessRequest,
	type ControlledProcessResult,
	InvalidProcessRequestError,
	pinnedExecutable,
	resolveExecutable,
	runControlledProcess,
	scrubSensitiveValues,
	UnsupportedExecutableError,
} from "./process.ts";

const BUN = resolveExecutable("bun");
const IS_POSIX = process.platform !== "win32";

/** Run a small bun child program with sane default limits. */
function runChild(
	program: string,
	overrides: Partial<ControlledProcessRequest> = {},
): Promise<ControlledProcessResult> {
	return runControlledProcess(BUN, {
		args: ["-e", program],
		env: {},
		timeoutMs: 10_000,
		maxOutputBytes: 4096,
		...overrides,
	});
}

describe("resolveExecutable", () => {
	test("resolves a supported runtime identifier to an absolute executable", () => {
		expect(BUN.id).toBe("bun");
		expect(BUN.path.startsWith("/")).toBe(true);
		expect(existsSync(BUN.path)).toBe(true);
	});

	test("rejects unsupported and target-provided command identifiers", () => {
		expect(() => resolveExecutable("/bin/sh")).toThrow(UnsupportedExecutableError);
		expect(() => resolveExecutable("target-provided-cmd")).toThrow(UnsupportedExecutableError);
		expect(() => resolveExecutable("")).toThrow(UnsupportedExecutableError);
	});
});

describe("pinnedExecutable", () => {
	test("rejects non-absolute artifact paths and empty ids", () => {
		expect(() => pinnedExecutable("fixture", "relative/path")).toThrow(InvalidProcessRequestError);
		expect(() => pinnedExecutable("fixture", "sh")).toThrow(InvalidProcessRequestError);
		expect(() => pinnedExecutable("fixture", "/abs\u0000")).toThrow(InvalidProcessRequestError);
		expect(() => pinnedExecutable("", "/abs")).toThrow(UnsupportedExecutableError);
	});
});

describe("runControlledProcess", () => {
	test("rejects invalid requests before spawning anything", async () => {
		await expect(runChild("process.exit(0)", { timeoutMs: 0 })).rejects.toThrow(
			InvalidProcessRequestError,
		);
		await expect(runChild("process.exit(0)", { timeoutMs: -5 })).rejects.toThrow(
			InvalidProcessRequestError,
		);
		await expect(runChild("process.exit(0)", { maxOutputBytes: 0 })).rejects.toThrow(
			InvalidProcessRequestError,
		);
		await expect(
			runControlledProcess(BUN, {
				args: [1] as unknown as readonly string[],
				timeoutMs: 100,
				maxOutputBytes: 16,
			}),
		).rejects.toThrow(InvalidProcessRequestError);
		await expect(
			runControlledProcess(BUN, {
				args: ["-e", "process.exit(0)"],
				env: { "BAD=KEY": "x" } as unknown as Record<string, string>,
				timeoutMs: 100,
				maxOutputBytes: 16,
			}),
		).rejects.toThrow(InvalidProcessRequestError);
		await expect(
			runControlledProcess(BUN, {
				args: ["-e", "process.exit(0)"],
				env: { FLAG: 1 } as unknown as Record<string, string>,
				timeoutMs: 100,
				maxOutputBytes: 16,
			}),
		).rejects.toThrow(InvalidProcessRequestError);
		await expect(
			runControlledProcess(BUN, null as unknown as ControlledProcessRequest),
		).rejects.toThrow(InvalidProcessRequestError);
	});

	test("captures stdout and the raw exit code of a finishing child", async () => {
		const result = await runChild("console.log('provider payload'); process.exit(3)");
		expect(result.outcome).toEqual({ kind: "exited", exitCode: 3 });
		expect(result.executableId).toBe("bun");
		expect(result.stdout).toBe("provider payload\n");
		expect(result.stderr).toBe("");
	});

	test("records exit 0 without claiming analysis completeness", async () => {
		const result = await runChild("process.exit(0)");
		expect(result.outcome).toEqual({ kind: "exited", exitCode: 0 });
		const serialized = JSON.stringify(result);
		expect(serialized.includes("complete")).toBe(false);
		expect(serialized.includes("success")).toBe(false);
	});

	test("reports a signal termination distinctly from an exit code", async () => {
		const result = await runChild("process.kill(process.pid, 'SIGTERM')");
		expect(result.outcome).toEqual({ kind: "signaled", signalCode: "SIGTERM" });
	});

	test("returns identical results for identical runs (no execution metadata)", async () => {
		const program = "console.log('fixed'); console.error('diag')";
		const first = await runChild(program);
		const second = await runChild(program);
		expect(second).toEqual(first);
		expect(Object.keys(second).sort()).toEqual(["executableId", "outcome", "stderr", "stdout"]);
	});

	test("passes a fixed argument array without any shell interpretation", async () => {
		const work = await mkdtemp(join(tmpdir(), "trellis-process-boundary-"));
		try {
			const marker = join(work, "shell-marker");
			const shellish = `$(touch ${marker})`;
			const result = await runChild("console.log(process.argv.slice(1).join('|'))", {
				args: ["-e", "console.log(process.argv.slice(1).join('|'))", shellish, "a; rm -rf /"],
			});
			expect(result.outcome).toEqual({ kind: "exited", exitCode: 0 });
			expect(result.stdout).toContain(shellish);
			expect(result.stdout).toContain("a; rm -rf /");
			expect(existsSync(marker)).toBe(false);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});

	test("gives the child exactly the explicit environment, inheriting nothing", async () => {
		const result = await runChild(
			"console.log(process.env.TRELLIS_TEST_FLAG ?? 'unset'); console.log(typeof process.env.HOME)",
			{ env: { TRELLIS_TEST_FLAG: "on" } },
		);
		expect(result.stdout).toBe("on\nundefined\n");
	});

	test("truncates and terminates on excessive stdout", async () => {
		const result = await runChild("for (let i = 0; i < 300; i++) console.log('x'.repeat(48));", {
			timeoutMs: 10_000,
			maxOutputBytes: 256,
		});
		expect(result.outcome.kind).toBe("output-overflow");
		expect(result.outcome).toMatchObject({ kind: "output-overflow", stream: "stdout" });
		expect(result.stdout.endsWith("...[truncated at 256 bytes]")).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(256 + "...[truncated at 256 bytes]".length);
	});

	test("truncates and terminates on excessive stderr", async () => {
		const result = await runChild("for (let i = 0; i < 300; i++) console.error('y'.repeat(48));", {
			maxOutputBytes: 192,
		});
		expect(result.outcome).toMatchObject({ kind: "output-overflow", stream: "stderr" });
		expect(result.stderr.endsWith("...[truncated at 192 bytes]")).toBe(true);
	});

	test("bounds stderr and scrubs sensitive environment values from it", async () => {
		const result = await runChild(
			"console.error('token=' + process.env.API_TOKEN); console.error('ordinary diagnostics')",
			{ env: { API_TOKEN: "sekrit-zz" } },
		);
		expect(result.stderr).toContain("token=[redacted]");
		expect(result.stderr).toContain("ordinary diagnostics");
		expect(result.stderr.includes("sekrit-zz")).toBe(false);
	});

	test("terminates the whole process group on the wall-time limit", async () => {
		const program = [
			"console.log(process.pid);",
			"Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], { stdout: 'inherit' });",
			"await Bun.sleep(30000);",
		].join(" ");
		const result = await runChild(program, { timeoutMs: 250, maxOutputBytes: 4096 });
		expect(result.outcome).toMatchObject({ kind: "timeout" });
		const pid = Number.parseInt(result.stdout, 10);
		expect(Number.isInteger(pid)).toBe(true);
		// The child and its inherited-stdout descendant are both gone.
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("terminates the child when the caller cancels mid-run", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const result = await runChild("await Bun.sleep(30000)", {
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		expect(result.outcome).toEqual({
			kind: "cancelled",
			reason: "cancelled by caller; process group terminated",
		});
	});

	test("cancels before start without executing anything", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runChild("await Bun.sleep(30000)", { signal: controller.signal });
		expect(result.outcome).toEqual({
			kind: "cancelled",
			reason: "cancelled before start; nothing was executed",
		});
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("locates a resolved executable that is missing on disk", async () => {
		const missing = pinnedExecutable("fixture-missing", join(tmpdir(), "no-such-provider-binary"));
		const result = await runControlledProcess(missing, {
			args: ["--version"],
			env: {},
			timeoutMs: 1000,
			maxOutputBytes: 1024,
		});
		expect(result.outcome).toMatchObject({ kind: "missing-executable" });
		expect(result.outcome.kind === "missing-executable" && result.outcome.reason.length > 0).toBe(
			true,
		);
	});

	test.skipIf(!IS_POSIX)("locates a startup failure for a non-executable artifact", async () => {
		const work = await mkdtemp(join(tmpdir(), "trellis-process-startup-"));
		try {
			const file = join(work, "not-executable");
			await writeFile(file, "not an executable\n");
			await chmod(file, 0o644);
			const noexec = pinnedExecutable("fixture-noexec", file);
			const result = await runControlledProcess(noexec, {
				args: ["--version"],
				env: {},
				timeoutMs: 1000,
				maxOutputBytes: 1024,
			});
			expect(result.outcome).toMatchObject({ kind: "startup-failed" });
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	});
});

describe("scrubSensitiveValues", () => {
	test("redacts values of sensitive environment keys wherever they appear", () => {
		expect(scrubSensitiveValues("a b c", { API_TOKEN: "b" })).toBe("a [redacted] c");
		expect(scrubSensitiveValues("twin b b", { PASSWORD: "b" })).toBe("twin [redacted] [redacted]");
	});

	test("keeps non-sensitive values and skips empty ones", () => {
		expect(scrubSensitiveValues("keep me", { NOTE: "me" })).toBe("keep me");
		expect(scrubSensitiveValues("nothing to do", { TOKEN: "" })).toBe("nothing to do");
	});
});
