import { add, mul } from "./calc.ts";

export function combine(a: number, b: number): number {
	return add(a, mul(a, b));
}
