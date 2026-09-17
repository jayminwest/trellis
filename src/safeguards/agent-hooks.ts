/**
 * Agent hook inspection (SPEC §5.5, trellis-a97d).
 *
 * One supported agent hook surface: the `hooks` map of **Claude Code**
 * `.claude/settings.json` (declarative JSON). Event entries carry
 * `{ matcher, hooks: [{ type, command }] }`; the hook *commands* are shell
 * and are never executed or interpreted.
 *
 * Evidence rules:
 *
 * - no settings file, or a settings file without a `hooks` map → `absent`;
 * - unparseable settings JSON → `unknown` (the surface cannot be read);
 * - a hook command referencing a committed repo-local script (e.g.
 *   `bash scripts/hooks/check.sh`) is verifiable → `structurally-wired` when
 *   every local reference resolves;
 * - a command referencing a **missing** local path → located broken-reference
 *   finding; the surface is at most `configured`;
 * - commands that are arbitrary shell with no recognizable local reference
 *   stay explicitly unverified — when that is all the map contains, the
 *   surface is `unknown`.
 *
 * Presence of agent *instructions* (AGENTS.md, CLAUDE.md, …) is never a
 * safeguard surface and grants no evidence of anything.
 */
import type { Finding, SafeguardLocation } from "../contract/index.ts";
import { extractLocalPaths } from "./shell.ts";
import type { SafeguardContext, SurfaceEvidence } from "./types.ts";
import { brokenPathFindings } from "./wiring.ts";

/** The supported agent hook surface (Claude Code). */
const CLAUDE_SETTINGS = ".claude/settings.json";

/** One hook command extracted from the settings `hooks` map. */
interface AgentHookCommand {
	/** The hook event (`PreToolUse`, …). */
	event: string;
	/** The shell command, verbatim. */
	command: string;
	/** 1-based line of the command string in the settings file. */
	line: number;
}

/** Commands of one event entry list (`[{ matcher, hooks: [{ command }] }]`). */
function commandsFromEvent(event: string, entries: unknown[], raw: string): AgentHookCommand[] {
	const commands: AgentHookCommand[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const inner = (entry as Record<string, unknown>).hooks;
		if (!Array.isArray(inner)) continue;
		for (const hook of inner) {
			const command = (hook as Record<string, unknown>)?.command;
			if (typeof command !== "string" || command.length === 0) continue;
			commands.push({ event, command, line: locateLine(raw, command) });
		}
	}
	return commands;
}

/** Collect `{ event, command, line }` for every hook entry in a parsed settings map. */
function collectHookCommands(settings: Record<string, unknown>, raw: string): AgentHookCommand[] {
	const hooks = settings.hooks;
	if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
	const commands: AgentHookCommand[] = [];
	for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
		if (Array.isArray(entries)) commands.push(...commandsFromEvent(event, entries, raw));
	}
	return commands;
}

/** 1-based line of the first occurrence of `needle` in `raw` (settings files are small). */
function locateLine(raw: string, needle: string): number {
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? "").includes(needle)) return i + 1;
	}
	return 1;
}

/** Per-command verification: count verified/unverified hooks, collect locations + findings. */
async function classifyCommands(
	ctx: SafeguardContext,
	commands: readonly AgentHookCommand[],
): Promise<{
	verified: number;
	unverified: number;
	locations: SafeguardLocation[];
	findings: Finding[];
}> {
	const locations: SafeguardLocation[] = [];
	const findings: Finding[] = [];
	let verified = 0;
	let unverified = 0;
	for (const hook of commands) {
		const localPaths = extractLocalPaths(hook.command);
		if (localPaths.length === 0) {
			unverified++;
			continue;
		}
		const broken = await brokenPathFindings(
			ctx,
			{ path: CLAUDE_SETTINGS, line: hook.line },
			hook.command,
			`${hook.event} hook`,
			localPaths,
		);
		findings.push(...broken);
		if (broken.length === 0) {
			verified++;
			for (const rel of localPaths) locations.push({ path: rel });
		}
	}
	return { verified, unverified, locations, findings };
}

/** Inspect the Claude Code agent hook surface. */
export async function inspectAgentHooks(ctx: SafeguardContext): Promise<SurfaceEvidence> {
	const raw = await ctx.readText(CLAUDE_SETTINGS);
	if (raw === null) return { level: "absent", locations: [], notes: [], findings: [] };
	let settings: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		settings = value as Record<string, unknown>;
	} catch {
		return {
			level: "unknown",
			locations: [{ path: CLAUDE_SETTINGS }],
			notes: [`${CLAUDE_SETTINGS} is not parseable JSON; hooks are unverified`],
			findings: [],
		};
	}
	const commands = collectHookCommands(settings, raw);
	if (commands.length === 0) {
		return { level: "absent", locations: [], notes: [], findings: [] };
	}
	const classified = await classifyCommands(ctx, commands);
	const { verified, unverified, locations, findings } = classified;
	const notes: string[] = [];
	locations.unshift({ path: CLAUDE_SETTINGS });
	if (unverified > 0) {
		notes.push(`${unverified} hook command(s) are arbitrary shell — explicitly unverified`);
	}
	if (verified === 0 && findings.length === 0) {
		return {
			level: "unknown",
			locations,
			notes: [
				`no hook command references a verifiable repo-local script (${commands.length} command(s))`,
				...notes,
			],
			findings,
		};
	}
	const wired = findings.length === 0;
	return {
		level: wired ? "structurally-wired" : "configured",
		locations,
		notes: [
			wired
				? `${verified} hook command(s) reference committed repo-local scripts`
				: `${verified} hook command(s) verified; ${findings.length} broken reference(s)`,
			...notes,
		],
		findings,
	};
}
