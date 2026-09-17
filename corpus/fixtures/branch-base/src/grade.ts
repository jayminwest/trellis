export function grade(score: number): string {
	if (score >= 90) {
		return "A";
	}
	if (score >= 80) {
		return "B";
	}
	return "C";
}
