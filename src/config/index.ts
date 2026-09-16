/**
 * Declarative audit configuration (SPEC §6.5) — load and validate
 * `trellis.yaml`: source exclusions/classification and failure policy as
 * data, with no executable hooks. Consumers: discovery overrides
 * (trellis-6003) and policy evaluation (trellis-942c).
 */
export { ConfigError, loadAuditConfig } from "./load.ts";
export {
	auditConfigSchema,
	metricBudgetSchema,
	parseAuditConfig,
	policyConfigSchema,
	sourceConfigSchema,
} from "./schema.ts";
export type {
	AuditConfig,
	MetricBudget,
	PolicyConfig,
	SourceConfig,
} from "./schema.ts";
