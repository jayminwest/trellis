import { invoiceTotal } from "./invoice.ts";
import { shippingCost } from "./shipping.ts";

export function quote(weightKg: number, distanceKm: number): number {
	return shippingCost(weightKg, distanceKm, false) + invoiceTotal(3, distanceKm, false);
}
