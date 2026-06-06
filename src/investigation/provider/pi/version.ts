/**
 * Pi discovery & version probe (SPEC §9.6).
 *
 * `pi` is a bare binary on `PATH` (operator-installed,
 * `@earendil-works/pi-coding-agent`). The RPC wire shape and the `toolCall`
 * envelope are version-sensitive, so trellis documents a supported Pi version
 * and probes it at startup via `pi --version`. A missing or incompatible Pi
 * degrades **every** agent criterion to `no-detector` with a clear hint — it
 * never crashes the audit.
 *
 * The check is a *minimum-version floor*: any Pi at or above
 * {@link MIN_SUPPORTED_PI_VERSION} is accepted (the RPC envelope shape trellis
 * depends on — assistant `message_end` `toolCall` blocks + `agent_end` — has
 * been stable since that floor). Below the floor, unparseable, or absent → not
 * compatible.
 */

/**
 * Documented baseline Pi version trellis is developed and golden-tested against
 * (mirrors burrow's pin). The golden fixtures (`trellis-f478`) are captured at
 * this version.
 */
export const SUPPORTED_PI_VERSION = "0.74.0";

/** Minimum Pi version accepted by the probe (the RPC-shape compatibility floor). */
export const MIN_SUPPORTED_PI_VERSION = "0.74.0";

/** Install/upgrade hint shown when Pi is missing or incompatible. */
export const PI_INSTALL_HINT =
	"install or update pi: `bun install -g @earendil-works/pi-coding-agent` " +
	`(trellis needs >= ${MIN_SUPPORTED_PI_VERSION}; run \`pi /login\` or set ANTHROPIC_API_KEY)`;

/** Outcome of {@link probePiVersion}. */
export type PiVersionProbe =
	| { readonly ok: true; readonly version: string }
	| { readonly ok: false; readonly reason: string; readonly hint: string };

/** Parse a `major.minor.patch` semver triple from arbitrary `pi --version` output. */
export function parseSemver(text: string): [number, number, number] | null {
	const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True iff `a` >= `b` (lexicographic over the semver triple). */
export function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
	for (let i = 0; i < 3; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		if (ai !== bi) return ai > bi;
	}
	return true;
}

/** Spawn `pi --version` and capture its trimmed stdout (injectable for tests). */
export type VersionSpawn = (
	bin: string,
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

const defaultVersionSpawn: VersionSpawn = async (bin) => {
	try {
		const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		return { exitCode, stdout };
	} catch {
		return { exitCode: 127, stdout: "" };
	}
};

/** Options for {@link probePiVersion}. */
export interface ProbePiVersionOptions {
	/** Override the `pi` binary name/path (default `"pi"`). */
	readonly piBin?: string;
	/** Inject the version spawn (tests pass a fake; default spawns the real `pi`). */
	readonly spawn?: VersionSpawn;
}

/**
 * Probe `pi --version` and decide compatibility (SPEC §9.6). A non-zero exit
 * (or missing binary) is "not installed"; a version below
 * {@link MIN_SUPPORTED_PI_VERSION} (or unparseable output) is "incompatible".
 * Both resolve `{ ok: false, reason, hint }` so the caller can degrade agent
 * criteria to `no-detector` without crashing.
 */
export async function probePiVersion(opts: ProbePiVersionOptions = {}): Promise<PiVersionProbe> {
	const bin = opts.piBin?.trim() || "pi";
	const spawn = opts.spawn ?? defaultVersionSpawn;
	const { exitCode, stdout } = await spawn(bin);
	if (exitCode !== 0) {
		return { ok: false, reason: `\`${bin} --version\` exited ${exitCode}`, hint: PI_INSTALL_HINT };
	}
	const parsed = parseSemver(stdout);
	if (!parsed) {
		return {
			ok: false,
			reason: `could not parse a version from \`${bin} --version\` output`,
			hint: PI_INSTALL_HINT,
		};
	}
	const floor = parseSemver(MIN_SUPPORTED_PI_VERSION);
	// Unreachable: the constant is a valid semver triple.
	if (!floor)
		return { ok: false, reason: "internal: bad min-version constant", hint: PI_INSTALL_HINT };
	const version = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
	if (!semverGte(parsed, floor)) {
		return {
			ok: false,
			reason: `pi ${version} is below the supported minimum ${MIN_SUPPORTED_PI_VERSION}`,
			hint: PI_INSTALL_HINT,
		};
	}
	return { ok: true, version };
}
