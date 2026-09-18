/** Work-accounting v2, frozen in docs/research/native-duplication (trellis-271c).
 * Every charge precedes the operation. Numeric allocation also charges zero initialization.
 * No production caller uses this candidate guard until the parity-gated cutover.
 */
export type DuplicationPhase =
	| "input"
	| "index"
	| "extraction"
	| "materialization"
	| "finalization";

export const DUPLICATION_LIMITS = {
	maxTokens: 2_000_000,
	maxMatchWork: 100_000_000,
	maxStreams: 100_000,
	maxWorkingCells: 32_000_000,
	maxGroups: 200_000,
	maxOccurrences: 1_000_000,
} as const;

type Limits = { -readonly [Key in keyof typeof DUPLICATION_LIMITS]: number };
export interface DuplicationWorkOptions extends Partial<Limits> {
	phaseLimits?: Partial<Record<DuplicationPhase, number>>;
	isCancelled?: () => boolean;
}

export interface DuplicationStop {
	phase: DuplicationPhase;
	kind: keyof Limits | "phase-work" | "cancelled";
	limit: number;
}

/** Internal structured control flow; only this error becomes incomplete evidence. */
export class DuplicationLimitError extends Error {
	constructor(readonly exhaustion: DuplicationStop) {
		super(`Duplication ${exhaustion.phase}: ${exhaustion.kind} (${exhaustion.limit})`);
	}
}

function checkedLimit(value: number, ceiling: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
		throw new RangeError(`Duplication limit must be an integer from 0 to ${ceiling}`);
	}
	return value;
}

export class DuplicationWork {
	readonly limits: Limits;
	readonly counts: Record<DuplicationPhase, number> = {
		input: 0,
		index: 0,
		extraction: 0,
		materialization: 0,
		finalization: 0,
	};
	readonly phaseLimits: Partial<Record<DuplicationPhase, number>>;
	phase: DuplicationPhase = "input";
	total = 0;
	liveCells = 0;
	peakCells = 0;
	groups = 0;
	occurrences = 0;
	private nextCheckpoint = 0;

	constructor(private readonly options: DuplicationWorkOptions = {}) {
		this.limits = { ...DUPLICATION_LIMITS };
		for (const key of Object.keys(DUPLICATION_LIMITS) as (keyof Limits)[]) {
			this.limits[key] = checkedLimit(options[key] ?? this.limits[key], this.limits[key]);
		}
		this.phaseLimits = { ...options.phaseLimits };
		for (const phase of Object.keys(this.counts) as DuplicationPhase[]) {
			const limit = this.phaseLimits[phase];
			if (limit !== undefined) checkedLimit(limit, this.limits.maxMatchWork);
		}
	}

	stop(kind: DuplicationStop["kind"], limit: number): never {
		throw new DuplicationLimitError({ phase: this.phase, kind, limit });
	}

	checkpoint(): void {
		if (this.options.isCancelled?.()) this.stop("cancelled", 0);
		this.nextCheckpoint = this.total + 1024;
	}

	enter(phase: DuplicationPhase): void {
		this.checkpoint();
		this.phase = phase;
		this.checkpoint();
	}

	charge(units = 1): void {
		if (this.total + units > this.limits.maxMatchWork) {
			this.stop("maxMatchWork", this.limits.maxMatchWork);
		}
		const phaseLimit = this.phaseLimits[this.phase] ?? this.limits.maxMatchWork;
		if (this.counts[this.phase] + units > phaseLimit) this.stop("phase-work", phaseLimit);
		if (this.total + units >= this.nextCheckpoint) this.checkpoint();
		this.total += units;
		this.counts[this.phase] += units;
	}

	reserve(cells: number): void {
		if (this.liveCells + cells > this.limits.maxWorkingCells) {
			this.stop("maxWorkingCells", this.limits.maxWorkingCells);
		}
		this.charge(cells);
		this.liveCells += cells;
		this.peakCells = Math.max(this.peakCells, this.liveCells);
	}

	release(cells: number): void {
		this.liveCells -= cells;
	}

	array(length: number): Uint32Array {
		this.reserve(length);
		return new Uint32Array(length);
	}

	retainGroup(): void {
		if (this.groups >= this.limits.maxGroups) this.stop("maxGroups", this.limits.maxGroups);
		this.charge();
		this.groups += 1;
	}

	retainOccurrence(): void {
		if (this.occurrences >= this.limits.maxOccurrences) {
			this.stop("maxOccurrences", this.limits.maxOccurrences);
		}
		this.charge();
		this.occurrences += 1;
	}
}
