import { registerBackupContribution } from "@/modules/backup/registry";
import { registerAction } from "@/modules/cron/actions/registry";
import { gimBackupContribution } from "./gim.backup";
import gimCleanupAction from "./gim.cleanup";

export { gimRawRoutes } from "./gim.raw.routes";
export { gimRoutes } from "./gim.routes";

registerBackupContribution(gimBackupContribution);
registerAction(gimCleanupAction);
