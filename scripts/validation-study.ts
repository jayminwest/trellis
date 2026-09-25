#!/usr/bin/env bun
/**
 * Validation study kit runner (trellis-f999, trellis-ba11).
 *
 *   bun run scripts/validation-study.ts packet   # blinded A/B packet for reviewers
 *   bun run scripts/validation-study.ts analyze  # signals + judgment analysis
 *
 * Reads docs/research/validation-study/{tasks,judgments}.json. Parses task
 * sources only; never executes them.
 */
import judgments from "../docs/research/validation-study/judgments.json";
import tasks from "../docs/research/validation-study/tasks.json";
import { analyzeStudy, blindedPacket, type Judgment } from "../src/research/validation-study.ts";

const mode = process.argv[2] ?? "analyze";
const output =
	mode === "packet" ? blindedPacket(tasks) : analyzeStudy(tasks, judgments as Judgment[]);
console.log(JSON.stringify(output, null, 2));
