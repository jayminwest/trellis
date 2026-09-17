export function invoiceTotal(itemCount: number, zoneKm: number, priority: boolean): number {
	const fee = 9.25;
	const perItem = 1.4;
	const perKm = 0.05;
	let total = fee + itemCount * perItem + zoneKm * perKm;
	if (itemCount > 15) {
		total += 8;
	}
	if (zoneKm > 300) {
		total += 18;
	}
	if (priority) {
		total = total * 1.5;
	}
	if (total > 350) {
		total = 350;
	}
	return Math.round(total * 100) / 100;
}
