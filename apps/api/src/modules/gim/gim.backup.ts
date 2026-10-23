import type { BackupContribution } from "@/modules/backup/registry";
import { gimReports, gimSlots } from "./schema";

export const gimBackupContribution: BackupContribution = {
  name: "gim",
  tables: [gimSlots, gimReports],
  deps: [],
};
