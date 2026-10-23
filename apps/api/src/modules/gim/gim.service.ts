import type { GimReportedMessage } from "./schema";
import type { AppDatabase } from "@/db";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { AppError } from "@/shared/lib/errors";
import { ulid } from "@/shared/lib/id";
import { gimReports, gimSlots } from "./schema";

/** Sealed bytes per slot, base64 included. */
export const MAX_SLOT_LENGTH = 256 * 1024;
export const MAX_SLOTS_PER_USER = 16;
/** Reports one user may file per day. */
export const MAX_REPORTS_PER_DAY = 50;

export const REPORT_REASONS = ["spam", "harassment", "inappropriate", "scam", "other"] as const;
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
      error: { code: this.code, message: this.message, details: { version: this.version } },
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
    const used = await db.select({ n: count() }).from(gimSlots).where(eq(gimSlots.userId, userId)).get();
    if ((used?.n ?? 0) >= MAX_SLOTS_PER_USER && !(await getSlot(db, userId, name)))
      throw new AppError(`At most ${MAX_SLOTS_PER_USER} slots per user`, 409, "TOO_MANY_SLOTS");
    const inserted = await db
      .insert(gimSlots)
      .values({ userId, name, version: 1, data, updatedAt })
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
    .select({ n: count() })
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
    .set({ status, resolvedAt: open ? null : new Date().toISOString(), resolvedBy: open ? null : by })
    .where(eq(gimReports.id, id))
    .returning({ id: gimReports.id });
  return updated.length === 1;
}
