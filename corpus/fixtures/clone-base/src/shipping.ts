export function shippingCost(weightKg: number, distanceKm: number, express: boolean): number {
	const base = 4.5;
	const perKg = 0.8;
	const perKm = 0.02;
	let cost = base + weightKg * perKg + distanceKm * perKm;
	if (weightKg > 20) {
		cost += 6;
	}
	if (distanceKm > 500) {
		cost += 12;
	}
	if (express) {
		cost = cost * 1.75;
	}
	if (cost > 200) {
		cost = 200;
	}
	return Math.round(cost * 100) / 100;
}
