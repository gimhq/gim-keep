import type { GimReportedMessage } from "./schema";
import type { AppDatabase } from "@/db";
import { and, count, countDistinct, desc, eq, gte, isNotNull, lt, max, ne, sql } from "drizzle-orm";
import { AppError } from "@/shared/lib/errors";
import { ulid } from "@/shared/lib/id";
import { gimReports, gimSlots } from "./schema";

/** Sealed bytes per slot, base64 included. */
export const MAX_SLOT_LENGTH = 256 * 1024;
export const MAX_SLOTS_PER_USER = 16;
/** Reports one user may file per day. */
export const MAX_REPORTS_PER_DAY = 50;

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "inappropriate",
  "scam",
  "other",
] as const;
export type ReportReason = typeof REPORT_REASONS[number];
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export class VersionConflictError extends AppError {
  constructor(public readonly version: number) {
    super(`Slot is at version ${version}`, 409, "VERSION_CONFLICT");
  }

  toJSON() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        details: { version: this.version },
      },
    };
  }
}

export interface Slot {
  readonly version: number;
  readonly data: string;
}

export async function getSlot(db: AppDatabase, userId: string, name: string): Promise<Slot | null> {
  const row = await db
    .select({ version: gimSlots.version, data: gimSlots.data })
    .from(gimSlots)
    .where(and(eq(gimSlots.userId, userId), eq(gimSlots.name, name)))
    .get();
  return row ?? null;
}

/**
 * Writes `data` as the next version of the slot if it is still at
 * `expectedVersion` (0: the slot does not exist yet), else throws
 * {@link VersionConflictError} with the current version.
 */
export async function putSlot(
  db: AppDatabase,
  userId: string,
  name: string,
  expectedVersion: number,
  data: string,
): Promise<number> {
  const updatedAt = new Date().toISOString();
  if (expectedVersion === 0) {
    const used = await db.select({
      n: count(),
    }).from(gimSlots).where(eq(gimSlots.userId, userId)).get();
    if ((used?.n ?? 0) >= MAX_SLOTS_PER_USER && !(await getSlot(db, userId, name)))
      throw new AppError(`At most ${MAX_SLOTS_PER_USER} slots per user`, 409, "TOO_MANY_SLOTS");
    const inserted = await db
      .insert(gimSlots)
      .values({
        userId,
        name,
        version: 1,
        data,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning({ version: gimSlots.version });
    if (inserted.length === 1)
      return 1;
  }
  else {
    const updated = await db
      .update(gimSlots)
      .set({ version: expectedVersion + 1, data, updatedAt })
      .where(and(eq(gimSlots.userId, userId), eq(gimSlots.name, name), eq(gimSlots.version, expectedVersion)))
      .returning({ version: gimSlots.version });
    if (updated.length === 1)
      return expectedVersion + 1;
  }
  const current = await getSlot(db, userId, name);
  throw new VersionConflictError(current?.version ?? 0);
}

export interface StorageUser {
  readonly userId: string;
  readonly slots: number;
  /** Stored (sealed, base64) bytes. */
  readonly bytes: number;
  readonly lastUpdatedAt: string;
}

export interface StoragePage {
  readonly items: StorageUser[];
  /** Users matching the query. */
  readonly total: number;
  readonly totals: { readonly users: number; readonly slots: number; readonly bytes: number };
}

/**
 * Per-user summary of the stored slots for the admin overview, most
 * recently updated first. Metadata only: slot contents are sealed by the
 * clients and never leave this module. `query` is a user id prefix.
 */
export async function listStorage(
  db: AppDatabase,
  opts: { readonly query?: string | undefined; readonly page: number; readonly limit: number },
): Promise<StoragePage> {
  const where = opts.query
    ? sql`substr(${gimSlots.userId}, 1, ${opts.query.length}) = ${opts.query}`
    : undefined;
  const lastUpdatedAt = max(gimSlots.updatedAt);
  const rows = await db
    .select({
      userId: gimSlots.userId,
      slots: count(),
      bytes: sql<number>`coalesce(sum(length(${gimSlots.data})), 0)`,
      lastUpdatedAt,
    })
    .from(gimSlots)
    .where(where)
    .groupBy(gimSlots.userId)
    .orderBy(desc(lastUpdatedAt), gimSlots.userId)
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit)
    .all();
  const matching = await db
    .select({
      n: countDistinct(gimSlots.userId),
    })
    .from(gimSlots)
    .where(where)
    .get();
  const totals = await db
    .select({
      users: countDistinct(gimSlots.userId),
      slots: count(),
      bytes: sql<number>`coalesce(sum(length(${gimSlots.data})), 0)`,
    })
    .from(gimSlots)
    .get();
  return {
    items: rows.map(r => ({
      ...r,
      bytes: Number(r.bytes),
      lastUpdatedAt: r.lastUpdatedAt ?? "",
    })),
    total: matching?.n ?? 0,
    totals: {
      users: totals?.users ?? 0,
      slots: totals?.slots ?? 0,
      bytes: Number(totals?.bytes ?? 0),
    },
  };
}

export interface SlotInfo {
  readonly name: string;
  readonly version: number;
  readonly bytes: number;
  readonly updatedAt: string;
}

/** One user's slots for the admin view: metadata only, never the data. */
export async function listUserSlots(db: AppDatabase, userId: string): Promise<SlotInfo[]> {
  const rows = await db
    .select({
      name: gimSlots.name,
      version: gimSlots.version,
      bytes: sql<number>`length(${gimSlots.data})`,
      updatedAt: gimSlots.updatedAt,
    })
    .from(gimSlots)
    .where(eq(gimSlots.userId, userId))
    .orderBy(gimSlots.name)
    .all();
  return rows.map(r => ({
    ...r,
    bytes: Number(r.bytes),
  }));
}

/**
 * Retention sweep: deletes slots not updated for `slotDays` days and
 * resolved or dismissed reports closed more than `reportDays` days ago.
 * Open reports are never deleted. An unset period skips that half.
 */
export async function purgeStale(
  db: AppDatabase,
  opts: { readonly slotDays?: number | undefined; readonly reportDays?: number | undefined; readonly now?: number },
): Promise<{ slots: number; reports: number }> {
  const now = opts.now ?? Date.now();
  const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  let slots = 0;
  let reports = 0;
  if (opts.slotDays !== undefined) {
    const deleted = await db
      .delete(gimSlots)
      .where(lt(gimSlots.updatedAt, cutoff(opts.slotDays)))
      .returning({ userId: gimSlots.userId });
    slots = deleted.length;
  }
  if (opts.reportDays !== undefined) {
    const deleted = await db
      .delete(gimReports)
      .where(and(
        ne(gimReports.status, "open"),
        isNotNull(gimReports.resolvedAt),
        lt(gimReports.resolvedAt, cutoff(opts.reportDays)),
      ))
      .returning({ id: gimReports.id });
    reports = deleted.length;
  }
  return { slots, reports };
}

/** Removes everything stored for a deleted account; its reports stay. */
export async function deleteUserData(db: AppDatabase, userId: string): Promise<number> {
  const deleted = await db.delete(gimSlots).where(eq(gimSlots.userId, userId)).returning({ name: gimSlots.name });
  return deleted.length;
}

export interface ReportInput {
  readonly reporterId: string;
  readonly reportedUserId: string;
  readonly reason: ReportReason;
  readonly note?: string | undefined;
  readonly messages: readonly GimReportedMessage[];
  readonly requestDigest: string;
}

/** Stores a report; a replayed request returns the report it created. */
export async function createReport(db: AppDatabase, input: ReportInput): Promise<string> {
  const replay = await db
    .select({ id: gimReports.id })
    .from(gimReports)
    .where(eq(gimReports.requestDigest, input.requestDigest))
    .get();
  if (replay)
    return replay.id;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await db
    .select({
      n: count(),
    })
    .from(gimReports)
    .where(and(eq(gimReports.reporterId, input.reporterId), gte(gimReports.createdAt, since)))
    .get();
  if ((recent?.n ?? 0) >= MAX_REPORTS_PER_DAY)
    throw new AppError("Too many reports today", 429, "RATE_LIMITED");
  const id = ulid();
  await db.insert(gimReports).values({
    id,
    reporterId: input.reporterId,
    reportedUserId: input.reportedUserId,
    reason: input.reason,
    note: input.note ?? null,
    messages: [...input.messages],
    requestDigest: input.requestDigest,
  });
  return id;
}

export async function listReports(db: AppDatabase, status: ReportStatus, limit: number) {
  return db
    .select({
      id: gimReports.id,
      reporterId: gimReports.reporterId,
      reportedUserId: gimReports.reportedUserId,
      reason: gimReports.reason,
      note: gimReports.note,
      messages: gimReports.messages,
      status: gimReports.status,
      createdAt: gimReports.createdAt,
      resolvedAt: gimReports.resolvedAt,
      resolvedBy: gimReports.resolvedBy,
    })
    .from(gimReports)
    .where(eq(gimReports.status, status))
    .orderBy(desc(gimReports.createdAt))
    .limit(limit)
    .all();
}

/** Sets a report's status; `false` if there is no such report. */
export async function setReportStatus(db: AppDatabase, id: string, status: ReportStatus, by: string): Promise<boolean> {
  const open = status === "open";
  const updated = await db
    .update(gimReports)
    .set({
      status,
      resolvedAt: open
        ? null
        : new Date().toISOString(),
      resolvedBy: open ? null : by,
    })
    .where(eq(gimReports.id, id))
    .returning({ id: gimReports.id });
  return updated.length === 1;
}
