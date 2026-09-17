import { celsiusToFahrenheit } from "./temperature.ts";

export function freezingPointFahrenheit(): number {
	return celsiusToFahrenheit(0);
}
