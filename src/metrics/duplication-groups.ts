/** Exact raw clone contracts shared by bounded indexing and finalization. */
/** One raw match member: a half-open token range [`start`, `end`) in the concatenated stream. */
export interface RawMember {
	/** Index into the detection run's stream array. */
	file: number;
	start: number;
	end: number;
}

/** A raw group under construction: members sharing one content-identical run. */
export interface RawGroup {
	/** Tokens per member run. */
	length: number;
	/** Representative member for content verification. */
	rep: RawMember;
	/** Members keyed by `${file}:${start}` (dedup). */
	members: Map<string, RawMember>;
}
