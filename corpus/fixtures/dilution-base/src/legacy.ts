export function classify(n: number): number {
	let out = 0;
	if (n < 0) {
		return -1;
	}
	if (n === 0) {
		out = 1;
	} else if (n < 3) {
		out = n * 2;
	}
	switch (n % 4) {
		case 0:
			out += 10;
			break;
		case 1:
			out += 20;
			break;
		default:
			out -= 1;
	}
	while (out > 30) {
		out -= 5;
	}
	for (let i = 0; i < n; i += 1) {
		if (i % 2 === 0) {
			out += i;
		}
	}
	if (n > 50 && out < 100) {
		out += 3;
	}
	return n > 100 ? out * 2 : out;
}
