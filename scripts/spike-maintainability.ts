/** Usage: bun scripts/spike-maintainability.ts <workspace> > evidence.json */
import {
	measureMaintainabilityPairs,
	runMaintainabilitySpike,
	summarizeMaintainability,
} from "../src/research/maintainability-spike.ts";

if (process.argv[2] === "--pairs") {
	console.log(JSON.stringify(measureMaintainabilityPairs(), null, 2));
} else {
	const report = await runMaintainabilitySpike(process.argv[2] ?? ".");
	console.log(
		JSON.stringify(
			process.argv[3] === "--summary" ? summarizeMaintainability(report) : report,
			null,
			2,
		),
	);
}
