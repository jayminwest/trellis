import { grade } from "./grade.ts";
import { label } from "./label.ts";

export function describe(score: number): string {
	return label(grade(score));
}
