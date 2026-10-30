import type { ActionDef } from "@/modules/cron/actions/types";
import { defineAction } from "@/modules/cron/actions/registry";
import { purgeStale } from "./gim.service";

export const MAX_RETENTION_DAYS = 365 * 10;

function days(value: unknown): number | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : Number(value);
}

/**
 * `gim-cleanup` cron action: the keep server's retention sweep. Ships
 * without a `defaultCron`, so nothing is deleted until an admin schedules
 * it with at least one period. Open reports are never deleted.
 */
const gimCleanupAction: ActionDef = defineAction({
  spec: {
    name: "gim-cleanup",
    displayName: "gim cleanup",
    description: "Delete gim storage slots not updated for N days and closed reports older than M days. Open reports are kept.",
    category: "maintenance",
    icon: "Trash2",
    tags: ["retention", "gim"],
    version: "1.0.0",
    inputs: [
      {
        key: "slotDays",
        label: "Slots: delete after (days without update)",
        type: "number",
        min: 1,
        max: MAX_RETENTION_DAYS,
        description: "Delete storage slots whose last update is older than this. Empty: keep slots.",
      },
      {
        key: "reportDays",
        label: "Reports: delete closed reports after (days)",
        type: "number",
        min: 1,
        max: MAX_RETENTION_DAYS,
        description: "Delete resolved or dismissed reports closed longer ago than this. Empty: keep reports.",
      },
    ],
    validate: async config =>
      days(config.slotDays) === undefined && days(config.reportDays) === undefined
        ? "Set slotDays, reportDays or both"
        : null,
  },
  execute: async (ctx, config) => {
    const { slots, reports } = await purgeStale(ctx.db, {
      slotDays: days(config.slotDays),
      reportDays: days(config.reportDays),
    });
    ctx.logger.info({ slots, reports }, "gim_cleanup_done");
    const plural = (n: number, word: string) => `${n} ${word}${n === 1
      ? ""
      : "s"}`;
    return `deleted ${plural(slots, "slot")} and ${plural(reports, "report")}`;
  },
});

export default gimCleanupAction;
