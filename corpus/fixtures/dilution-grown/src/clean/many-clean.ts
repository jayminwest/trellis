/** Clean module: small, varied, branch-free helpers (the "large clean addition"). */
export function pad2(value: number): string {
	const text = String(value);
	return text.length === 1 ? `0${text}` : text;
}

export function clampPositive(value: number): number {
	return Math.max(0, value);
}

export function midpoint(a: number, b: number): number {
	return (a + b) / 2;
}

export function hypotenuse(a: number, b: number): number {
	return Math.sqrt(a * a + b * b);
}

export function joinPath(parts: readonly string[]): string {
	return parts.filter((part) => part.length > 0).join("/");
}

export function sumList(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

export function repeatText(text: string, times: number): string {
	return text.repeat(Math.max(0, times));
}

export function invertFlag(flag: boolean): boolean {
	return !flag;
}

export function celsiusToKelvin(celsius: number): number {
	return celsius + 273.15;
}

export function areaOfCircle(radius: number): number {
	return Math.PI * radius ** 2;
}

export function initials(name: string): string {
	return name
		.split(" ")
		.map((part) => part.charAt(0).toUpperCase())
		.join("");
}

export function percentage(part: number, whole: number): number {
	return (part / whole) * 100;
}

export function snakeCase(text: string): string {
	return text.trim().toLowerCase().split(/\s+/).join("_");
}

export function pluralize(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}

export function rangeList(size: number): number[] {
	return Array.from({ length: Math.max(0, size) }, (_, index) => index);
}

export function lastOf<T>(items: readonly T[]): T | undefined {
	return items[items.length - 1];
}

export function uniqueTexts(items: readonly string[]): string[] {
	return [...new Set(items)];
}

export function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : sumList(values) / values.length;
}

export function wrapInBrackets(text: string): string {
	return `[${text}]`;
}

export function isEven(value: number): boolean {
	return value % 2 === 0;
}

export function milesToKm(miles: number): number {
	return miles * 1.609344;
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
