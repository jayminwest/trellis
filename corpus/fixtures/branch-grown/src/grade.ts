export function grade(score: number): string {
	let out = "F";
	if (score < 0) {
		return "invalid";
	}
	if (score >= 10) {
		out = "E";
	} else if (score < 5) {
		out = "F-";
	}
	switch (Math.floor(score / 20)) {
		case 1:
			out = "D";
			break;
		case 2:
			out = "C-";
			break;
		default:
			break;
	}
	while (out === "C-" && score > 55) {
		out = "C";
	}
	for (let cut = 60; cut <= 90; cut += 10) {
		if (score >= cut) {
			out = `B${cut}`;
		}
	}
	if (score > 92 && score <= 96) {
		out = "A-";
	}
	if (score > 96) {
		out = "A";
	}
	return score >= 100 ? "A+" : out;
}
