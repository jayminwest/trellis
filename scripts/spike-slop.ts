/** Usage: bun scripts/spike-slop.ts [workspace] > report.json */
import { runSlopSpike } from "../src/research/slop-spike.ts";

try {
	console.log(JSON.stringify(await runSlopSpike(process.argv[2] ?? "."), null, 2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
