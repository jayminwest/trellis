import { expect, test } from "bun:test";
import { VERSION } from "./index.ts";

test("VERSION is a semver string", () => {
	expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
