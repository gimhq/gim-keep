import type { AppDatabase } from "@/db";
import type { ActionContext } from "@/modules/cron/actions/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { __resetActionRegistryForTests, registerAction, validateActionConfig } from "@/modules/cron/actions/registry";
import gimCleanupAction from "./gim.cleanup";
import { createReport, listStorage, listUserSlots, putSlot, setReportStatus } from "./gim.service";
import { gimReports, gimSlots } from "./schema";

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as ActionContext["logger"];
const DAY = 24 * 60 * 60 * 1000;

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "gim-admin-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

async function age(userId: string, days: number) {
  await db.update(gimSlots).set({
    updatedAt: daysAgo(days),
  }).where(eq(gimSlots.userId, userId)).run();
}

describe("storage overview", () => {
  test("summarises slots per user without exposing their contents", async () => {
    await putSlot(db, "ualice", "privacy", 0, "a".repeat(10));
    await putSlot(db, "ualice", "settings", 0, "b".repeat(30));
    await putSlot(db, "ubob", "privacy", 0, "c".repeat(5));
    await age("ubob", 3);

    const page = await listStorage(db, { page: 1, limit: 50 });

    expect(page.total).toBe(2);
    expect(page.totals).toEqual({ users: 2, slots: 3, bytes: 45 });
    // Most recently updated first.
    expect(page.items.map(i => i.userId)).toEqual(["ualice", "ubob"]);
    expect(page.items[0]).toMatchObject({ slots: 2, bytes: 40 });
    expect(JSON.stringify(page)).not.toContain("aaaa");
  });

  test("filters by user id prefix and pages", async () => {
    for (const id of ["ua1", "ua2", "ua3", "ub1"])
      await putSlot(db, id, "privacy", 0, "x");

    const filtered = await listStorage(db, { query: "ua", page: 1, limit: 2 });

    expect(filtered.total).toBe(3);
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every(i => i.userId.startsWith("ua"))).toBe(true);
    expect((await listStorage(db, { query: "ua", page: 2, limit: 2 })).items).toHaveLength(1);
  });

  test("lists one user's slots as metadata only", async () => {
    await putSlot(db, "ualice", "privacy", 0, "sealed-1");
    await putSlot(db, "ualice", "privacy", 1, "sealed-22");

    const slots = await listUserSlots(db, "ualice");

    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ name: "privacy", version: 2, bytes: 9 });
    expect(slots[0]).not.toHaveProperty("data");
    expect(await listUserSlots(db, "unobody")).toEqual([]);
  });
});

describe("gim-cleanup action", () => {
  beforeEach(() => {
    __resetActionRegistryForTests();
    registerAction(gimCleanupAction);
  });

  const run = (config: Record<string, unknown>) =>
    gimCleanupAction.execute({ db, logger: noop, config: {} as ActionContext["config"] }, config);

  async function report(digest: string, status: "open" | "resolved" | "dismissed", resolvedDaysAgo?: number) {
    const id = await createReport(db, {
      reporterId: "ualice",
      reportedUserId: "ubob",
      reason: "spam",
      messages: [],
      requestDigest: digest,
    });
    if (status !== "open")
      await setReportStatus(db, id, status, "admin");
    if (resolvedDaysAgo !== undefined) {
      await db.update(gimReports).set({
        resolvedAt: daysAgo(resolvedDaysAgo),
      }).where(eq(gimReports.id, id)).run();
    }
    return id;
  }

  test("needs at least one retention period", async () => {
    expect(await validateActionConfig("gim-cleanup", { action: "gim-cleanup" })).not.toBeNull();
    expect(await validateActionConfig("gim-cleanup", { action: "gim-cleanup", slotDays: 90 })).toBeNull();
    expect(await validateActionConfig("gim-cleanup", { action: "gim-cleanup", reportDays: 30 })).toBeNull();
  });

  test("deletes only slots not updated within slotDays", async () => {
    await putSlot(db, "uold", "privacy", 0, "x");
    await putSlot(db, "unew", "privacy", 0, "y");
    await age("uold", 100);

    const result = await run({ slotDays: 90 });

    expect(result).toContain("1 slot");
    expect(await listUserSlots(db, "uold")).toEqual([]);
    expect(await listUserSlots(db, "unew")).toHaveLength(1);
  });

  test("deletes only closed reports older than reportDays and never open ones", async () => {
    const oldResolved = await report("d1", "resolved", 40);
    const oldDismissed = await report("d2", "dismissed", 40);
    const recentResolved = await report("d3", "resolved", 5);
    const open = await report("d4", "open");
    await db.update(gimReports).set({
      createdAt: daysAgo(400),
    }).where(eq(gimReports.id, open)).run();

    const result = await run({ reportDays: 30 });

    expect(result).toContain("2 reports");
    const left = (await db.select({ id: gimReports.id }).from(gimReports).all()).map(r => r.id).sort();
    expect(left).toEqual([recentResolved, open].sort());
    expect(left).not.toContain(oldResolved);
    expect(left).not.toContain(oldDismissed);
  });

  test("leaves reports alone when only slotDays is set", async () => {
    await report("d1", "resolved", 400);

    await run({ slotDays: 1 });

    expect(await db.select().from(gimReports).all()).toHaveLength(1);
  });
});
