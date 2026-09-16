/**
 * Declarative audit configuration (SPEC §6.5): load + validate. The contract
 * itself lives in `src/contract/config.ts`; this module is the filesystem
 * boundary that reads `trellis.yaml` into it.
 */
export { CONFIG_FILENAMES, loadAuditConfig } from "./load.ts";
