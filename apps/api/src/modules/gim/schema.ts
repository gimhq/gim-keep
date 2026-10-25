import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One storage slot of a gim user. `data` is sealed by the client with a key
// derived from the user's root key (gim-core docs/identity.md "Keep-server
// storage"), base64; the server only keeps and versions it.
export const gimSlots = sqliteTable("gim_slots", {
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  data: text("data").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [primaryKey({ columns: [t.userId, t.name] })]);

// An abuse report: the messages the reporter chose, in plaintext, as the
// reporter's client decrypted them. Kept after either account is deleted.
export const gimReports = sqliteTable("gim_reports", {
  id: text("id").primaryKey(),
  reporterId: text("reporter_id").notNull(),
  reportedUserId: text("reported_user_id").notNull(),
  reason: text("reason").notNull(),
  note: text("note"),
  messages: text("messages", { mode: "json" }).notNull().$type<GimReportedMessage[]>(),
  status: text("status").notNull().default("open"),
  // SHA-256 of the request signature: a replayed request adds no report.
  requestDigest: text("request_digest").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
}, t => [index("idx_gim_reports_status_created").on(t.status, t.createdAt)]);

export interface GimReportedMessage {
  readonly messageId: string;
  readonly senderUserId: string;
  readonly sentAtMs: number;
  readonly text: string;
}
