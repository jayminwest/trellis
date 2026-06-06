/**
 * TypeScript adapter — §5.6 Observability detectors (deterministic subset).
 *
 * Both are non-skippable: a TypeScript app has a logging/error surface, so absent
 * tooling is a fail (SPEC §3.2), never N/A. We recognize a structured-logging
 * library (pino/winston/…) and a contextualized error tracker (Sentry/Bugsnag/…)
 * as declared dependencies — the honest "is the capability present" signal a
 * deterministic pass demands.
 */
import { packageDeps, readJson } from "../../common/util.ts";
import { type Detector, fail, pass } from "../../types.ts";
import { depsHasAny } from "./util.ts";

/** Structured-logging libraries (emit JSON/structured records, not bare console). */
const STRUCTURED_LOGGERS = [
	"pino",
	"winston",
	"bunyan",
	"roarr",
	"loglevel",
	"consola",
	"@aws-lambda-powertools/logger",
	"slog",
	"signale",
	"tslog",
] as const;

/** Contextualized error trackers (capture stack + structured context). */
const ERROR_TRACKERS = [
	"@sentry/node",
	"@sentry/browser",
	"@sentry/react",
	"@sentry/nextjs",
	"@sentry/bun",
	"@bugsnag/js",
	"@bugsnag/node",
	"rollbar",
	"@rollbar/react",
	"@honeybadger-io/js",
	"@airbrake/browser",
	"elastic-apm-node",
	"newrelic",
	"@datadog/browser-rum",
	"dd-trace",
] as const;

/** `structured_logging` (A/L2, GATE): a structured-logging library/module. */
export const structuredLogging: Detector = async (ctx) => {
	const deps = packageDeps(await readJson(ctx, "package.json"));
	const hit = STRUCTURED_LOGGERS.find((n) => deps.has(n));
	if (hit !== undefined) return pass(`structured-logging library declared: '${hit}'`);
	return fail("no structured-logging library declared (pino/winston/bunyan/…)");
};

/** `error_tracking_contextualized` (A/L2): an error tracker with stack/context. */
export const errorTrackingContextualized: Detector = async (ctx) => {
	const deps = packageDeps(await readJson(ctx, "package.json"));
	const hit = ERROR_TRACKERS.find((n) => deps.has(n));
	if (hit !== undefined) return pass(`contextualized error tracker declared: '${hit}'`);
	if (depsHasAny(deps, ["@opentelemetry/api"])) {
		return pass("OpenTelemetry instrumentation declared (captures error context)");
	}
	return fail("no contextualized error tracker declared (Sentry/Bugsnag/Rollbar/…)");
};
