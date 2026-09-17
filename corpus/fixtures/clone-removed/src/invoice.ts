import { shippingCost } from "./shipping.ts";

export function invoiceTotal(itemCount: number, zoneKm: number, priority: boolean): number {
	return shippingCost(itemCount, zoneKm, priority);
}
