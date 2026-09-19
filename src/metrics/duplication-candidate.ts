/** Isolated bounded candidate. Not selected by the audit before trellis-b594 acceptance. */
import type { FileSyntax } from "../syntax/index.ts";
import { type CloneGroup, collectControlledTokens, type TokenStream } from "./duplication.ts";
import { accountCandidateLines } from "./duplication-account.ts";
import { extractCloneGroups } from "./duplication-extract.ts";
import { finalizeCandidateGroups } from "./duplication-finalize.ts";
import { rankTokenStreams } from "./duplication-index-input.ts";
import { orderRawGroups } from "./duplication-order.ts";
import { longestCommonPrefixes, suffixArray } from "./duplication-suffix.ts";
import {
	DuplicationLimitError,
	type DuplicationStop,
	DuplicationWork,
	type DuplicationWorkOptions,
} from "./duplication-work.ts";

export interface CandidateDetection {
	groups: CloneGroup[];
	tokenCount: number;
	exhaustion: DuplicationStop | null;
	/** Null when line accounting was not requested or the pass was incomplete. */
	totals: ReturnType<typeof accountCandidateLines> | null;
	work: {
		total: number;
		phases: DuplicationWork["counts"];
		peakCells: number;
		groups: number;
		occurrences: number;
	};
}

function collectFiles(files: readonly FileSyntax[], work: DuplicationWork): TokenStream[] {
	work.enter("input");
	if (files.length > work.limits.maxStreams) work.stop("maxStreams", work.limits.maxStreams);
	const streams: TokenStream[] = [];
	const sourceSet = files[0]?.sourceSet;
	const control = {
		charge: (units = 1) => work.charge(units),
		reserve: (cells: number) => work.reserve(cells),
		release: (cells: number) => work.release(cells),
		token: () => {
			work.inputTokens += 1;
			if (work.inputTokens > work.limits.maxTokens) work.stop("maxTokens", work.limits.maxTokens);
			work.reserve(3);
		},
	};
	for (const file of files) {
		work.charge();
		if (file.sourceSet !== sourceSet) throw new Error("Duplication requires one source set");
		streams.push(collectControlledTokens(file, control));
	}
	work.checkpoint();
	return streams;
}

function detect(streams: readonly TokenStream[], work: DuplicationWork): CloneGroup[] {
	work.enter("input");
	if (streams.length > work.limits.maxStreams) work.stop("maxStreams", work.limits.maxStreams);
	const sourceSet = streams[0]?.sourceSet;
	for (const stream of streams) {
		work.charge();
		if (stream.sourceSet !== sourceSet) throw new Error("Duplication requires one source set");
	}
	const data = rankTokenStreams(streams, work);
	if (data.tokens.length === 0) return [];
	const sa = suffixArray(data.tokens, data.alphabetSize, work);
	const lcp = longestCommonPrefixes(data.tokens, sa, work);
	const raw = extractCloneGroups(data, sa, lcp, work);
	orderRawGroups(raw, streams, data, work);
	return finalizeCandidateGroups(raw, streams, data.fileStart, work);
}

function result(
	work: DuplicationWork,
	groups: CloneGroup[],
	totals: CandidateDetection["totals"],
	exhaustion: DuplicationStop | null,
): CandidateDetection {
	return {
		groups,
		totals,
		exhaustion,
		tokenCount: work.inputTokens,
		work: {
			total: work.total,
			phases: { ...work.counts },
			peakCells: work.peakCells,
			groups: work.groups,
			occurrences: work.occurrences,
		},
	};
}

/** Only a budget/cancellation stop becomes incomplete. No partial groups escape. */
function run(
	work: DuplicationWork,
	operation: () => { groups: CloneGroup[]; totals: CandidateDetection["totals"] },
): CandidateDetection {
	try {
		work.checkpoint();
		const { groups, totals } = operation();
		work.checkpoint();
		return result(work, groups, totals, null);
	} catch (error) {
		if (!(error instanceof DuplicationLimitError)) throw error;
		return result(work, [], null, error.exhaustion);
	}
}

export function detectCandidateClones(
	streams: readonly TokenStream[],
	options: DuplicationWorkOptions = {},
): CandidateDetection {
	const work = new DuplicationWork(options);
	return run(work, () => ({ groups: detect(streams, work), totals: null }));
}

/** Collection, detection, materialization, containment and line unions share one budget. */
export function measureCandidateScope(
	files: readonly FileSyntax[],
	options: DuplicationWorkOptions = {},
): CandidateDetection {
	const work = new DuplicationWork(options);
	return run(work, () => {
		const groups = detect(collectFiles(files, work), work);
		return { groups, totals: accountCandidateLines(files, groups, work) };
	});
}
