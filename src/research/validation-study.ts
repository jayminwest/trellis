/**
 * Independent validation study kit (trellis-f999, trellis-ba11). Internal
 * research only: no audit, CLI/SDK, scoring or budget reads this module.
 *
 * Held-out maintenance tasks (`docs/research/validation-study/tasks.json`)
 * pair a `before` and `after` TypeScript version of the same behavior. The
 * kit parses both (never executes them), measures the candidate signals
 * beside LOC, CC and duplication, emits a **blinded** A/B packet for
 * reviewers, and — once independent judgments exist — reports agreement,
 * false positives and misses per signal. With too few judgments it reports
 * `awaiting-independent-judgments` and draws no conclusion.
 */
import { createHash } from "node:crypto";
import {
	collectFunctions,
	countLines,
	parseSource,
	type SyntaxInventory,
} from "../syntax/index.ts";
import { measureMaintainability } from "./maintainability-spike.ts";
import { dispatchesIn, forwarderAt } from "./slop-signals.ts";

/** One held-out maintenance task. */
export interface StudyTask {
	id: string;
	category: string;
	issues: string[];
	/** The maintenance change a reviewer imagines making to each version. */
	task: string;
	before: string;
	after: string;
}

/** One reviewer's blinded preference for one task. */
export interface Judgment {
	taskId: string;
	reviewer: string;
	/** Which blinded version is easier to change safely for the task, or `same`. */
	preferred: "A" | "B" | "same";
	/** Reviewer did not author the task and did not see signal values. */
	independent: boolean;
}

/** Signals measured on one version (lower is conventionally "better"). */
export const SIGNALS = [
	"loc",
	"totalCc",
	"maxCc",
	"totalFlow",
	"maxFlow",
	"functions",
	"forwarders",
	"dispatches",
	"cloneGroups",
] as const;
export type Signal = (typeof SIGNALS)[number];
export type SignalValues = Record<Signal, number>;

/** Minimum independent reviewers per task before its verdict counts. */
export const MIN_REVIEWERS = 2;

/** Build a one-file syntax inventory for an in-memory source (never executed). */
function inventoryOf(source: string): SyntaxInventory {
	const parsed = parseSource("task.ts", source);
	const facts = collectFunctions(parsed.sourceFile);
	return {
		root: "/study",
		compilerVersion: "study",
		functionCount: facts.functions.length,
		completeness: parsed.diagnostics.length > 0 ? "incomplete" : "complete",
		diagnostics: parsed.diagnostics,
		files: [
			{
				...parsed,
				...facts,
				path: "task.ts",
				packagePath: ".",
				sourceSet: "production",
				lines: countLines(parsed.sourceFile),
			},
		],
	};
}

/** Measure every candidate signal on one version. */
export function measureSignals(source: string): SignalValues {
	const inventory = inventoryOf(source);
	const file = inventory.files[0];
	if (file === undefined || file.diagnostics.length > 0) {
		throw new Error("study task source does not parse cleanly");
	}
	const report = measureMaintainability(inventory);
	const cc = report.functions.map((fn) => fn.cc);
	const flow = report.functions.map((fn) => fn.flow);
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	return {
		loc: file.lines.code,
		totalCc: sum(cc),
		maxCc: Math.max(0, ...cc),
		totalFlow: sum(flow),
		maxFlow: Math.max(0, ...flow),
		functions: file.functions.length,
		forwarders: file.functions.filter((fn) => forwarderAt(file, fn) !== undefined).length,
		dispatches: dispatchesIn(file).length,
		cloneGroups: report.summary.cloneGroups ?? 0,
	};
}

/** Deterministic blinding: whether version A is the `after` side for a task. */
export function aIsAfter(taskId: string): boolean {
	const first = createHash("sha256").update(taskId).digest()[0] ?? 0;
	return first % 2 === 1;
}

/** The reviewer packet: task text and A/B sources only — no signals, no labels. */
export function blindedPacket(tasks: readonly StudyTask[]) {
	return tasks.map((task) => {
		const flip = aIsAfter(task.id);
		return {
			id: task.id,
			task: task.task,
			A: flip ? task.after : task.before,
			B: flip ? task.before : task.after,
		};
	});
}

type Verdict = "after-better" | "before-better" | "same";

/** Map a blinded preference back to before/after. */
function unblind(judgment: Judgment): Verdict {
	if (judgment.preferred === "same") return "same";
	return (judgment.preferred === "A") === aIsAfter(judgment.taskId)
		? "after-better"
		: "before-better";
}

/** Majority verdict over independent reviewers, or null below {@link MIN_REVIEWERS} or on a tie. */
function taskVerdict(judgments: readonly Judgment[]): {
	verdict: Verdict | null;
	agreement: number;
} {
	const verdicts = judgments.filter((j) => j.independent).map(unblind);
	if (new Set(judgments.filter((j) => j.independent).map((j) => j.reviewer)).size < MIN_REVIEWERS) {
		return { verdict: null, agreement: 0 };
	}
	const counts = new Map<Verdict, number>();
	for (const verdict of verdicts) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const [top, second] = ranked;
	const agreement = (top?.[1] ?? 0) / verdicts.length;
	return { verdict: top !== undefined && top[1] !== second?.[1] ? top[0] : null, agreement };
}

/** Per-signal comparison against reviewer verdicts. */
interface SignalOutcome {
	signal: Signal;
	/** Signal moved the way reviewers preferred. */
	agrees: number;
	/** Signal "improved" (decreased) while reviewers preferred `before`. */
	falsePositives: string[];
	/** Reviewers preferred `after` but the signal did not decrease. */
	misses: string[];
}

/** One decided task's signal delta classified against the reviewer verdict. */
function classify(
	verdict: Verdict | null,
	delta: number,
): "agrees" | "falsePositive" | "miss" | null {
	if (verdict === "after-better") return delta < 0 ? "agrees" : "miss";
	if (verdict !== "before-better") return null;
	if (delta > 0) return "agrees";
	return delta < 0 ? "falsePositive" : null;
}

/** Compare one signal with every decided task's verdict. */
function signalOutcome(
	signal: Signal,
	decided: readonly {
		id: string;
		verdict: Verdict | null;
		before: SignalValues;
		after: SignalValues;
	}[],
): SignalOutcome {
	const outcome: SignalOutcome = { signal, agrees: 0, falsePositives: [], misses: [] };
	for (const task of decided) {
		const kind = classify(task.verdict, task.after[signal] - task.before[signal]);
		if (kind === "agrees") outcome.agrees += 1;
		else if (kind === "falsePositive") outcome.falsePositives.push(task.id);
		else if (kind === "miss") outcome.misses.push(task.id);
	}
	return outcome;
}

/** Run the study over tasks and judgments (see the module docblock). */
export function analyzeStudy(tasks: readonly StudyTask[], judgments: readonly Judgment[]) {
	const measured = tasks.map((task) => {
		const before = measureSignals(task.before);
		const after = measureSignals(task.after);
		const { verdict, agreement } = taskVerdict(judgments.filter((j) => j.taskId === task.id));
		return {
			id: task.id,
			category: task.category,
			issues: task.issues,
			before,
			after,
			verdict,
			agreement,
		};
	});
	const decided = measured.filter((task) => task.verdict !== null && task.verdict !== "same");
	const outcomes = SIGNALS.map((signal) => signalOutcome(signal, decided));
	return {
		protocol: "validation-study-v1",
		status: decided.length === 0 ? "awaiting-independent-judgments" : "judged",
		tasks: measured,
		decidedTasks: decided.length,
		outcomes: decided.length === 0 ? [] : outcomes,
	};
}
