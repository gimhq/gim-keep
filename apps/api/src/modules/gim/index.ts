import { registerBackupContribution } from "@/modules/backup/registry";
import { gimBackupContribution } from "./gim.backup";

export { gimRawRoutes } from "./gim.raw.routes";
export { gimRoutes } from "./gim.routes";

registerBackupContribution(gimBackupContribution);
