import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { deleteUserData, listReports, listStorage, listUserSlots, REPORT_STATUSES, setReportStatus } from "./gim.service";

const reportSchema = z.object({
  id: z.string(),
  reporterId: z.string(),
  reportedUserId: z.string(),
  reason: z.string(),
  note: z.string().nullable(),
  messages: z.array(z.object({
    messageId: z.string(),
    senderUserId: z.string(),
    sentAtMs: z.number(),
    text: z.string(),
  })),
  status: z.enum(REPORT_STATUSES),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
});

const listQuery = z.object({
  status: z.enum(REPORT_STATUSES).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const statusBody = z.object({
  status: z.enum(REPORT_STATUSES),
});

const storageQuery = z.object({
  q: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const storageUserSchema = z.object({
  userId: z.string(),
  slots: z.number(),
  bytes: z.number(),
  lastUpdatedAt: z.string(),
});

const slotInfoSchema = z.object({
  name: z.string(),
  version: z.number(),
  bytes: z.number(),
  updatedAt: z.string(),
});

/**
 * Admin surface of the gim module (browser session, admins only): the
 * moderators' report inbox and the storage overview. Storage is shown as
 * metadata only; slot contents are sealed by the clients.
 */
export function gimRoutes() {
  const router = new Hono<AppEnv>();
  router.use("/gim/*", authRequired);

  router.get(
    "/gim/reports",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "List reports",
      description: "Abuse reports from gim users, newest first. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(reportSchema), "Reports"),
        ...errors(401, 403, 422),
      },
    }),
    adminRequired,
    validator("query", listQuery),
    async (c) => {
      const { status, limit } = c.req.valid("query");
      return c.json({ success: true, data: await listReports(c.get("db"), status, limit) });
    },
  );

  router.patch(
    "/gim/reports/:id",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Set a report's status",
      description: "Resolve or dismiss a report, or reopen it. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          id: z.string(),
        }), "Updated"),
        ...errors(401, 403, 404, 422),
      },
    }),
    adminRequired,
    validator("json", statusBody),
    async (c) => {
      const db = c.get("db");
      const actor = c.get("user")!;
      const id = c.req.param("id");
      const { status } = c.req.valid("json");
      if (!(await setReportStatus(db, id, status, actor.id)))
        throw new NotFoundError("Report", id);
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: `gim.report.${status}`,
        resourceType: "gim_report",
        resourceId: id,
        resourceName: id,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({
        success: true,
        data: { id },
      });
    },
  );

  router.get(
    "/gim/storage",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "List stored users",
      description: "Per-user slot count, stored bytes and last update, most recent first; `q` is a user id prefix. Metadata only. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(storageUserSchema), "Users with stored slots"),
        ...errors(401, 403, 422),
      },
    }),
    adminRequired,
    validator("query", storageQuery),
    async (c) => {
      const { q, page, limit } = c.req.valid("query");
      const result = await listStorage(c.get("db"), { query: q || undefined, page, limit });
      return c.json({
        success: true,
        data: result.items,
        meta: {
          total: result.total,
          page,
          limit,
          totals: result.totals,
        },
      });
    },
  );

  router.get(
    "/gim/storage/:userId",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "List a user's slots",
      description: "Slot names, versions, sizes and update times of one user; never the sealed data. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(slotInfoSchema), "Slots"),
        ...errors(401, 403),
      },
    }),
    adminRequired,
    async (c) => {
      return c.json({ success: true, data: await listUserSlots(c.get("db"), c.req.param("userId")) });
    },
  );

  router.delete(
    "/gim/storage/:userId",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Delete a user's slots",
      description: "Removes every slot of the user, as the user's own account deletion does; reports stay. Audited. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          deleted: z.number(),
        }), "Deleted slot count"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const actor = c.get("user")!;
      const userId = c.req.param("userId");
      const deleted = await deleteUserData(db, userId);
      if (deleted === 0)
        throw new NotFoundError("Stored user", userId);
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "gim.storage.deleted",
        resourceType: "gim_storage",
        resourceId: userId,
        resourceName: userId,
        detail: { slots: deleted },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({
        success: true,
        data: { deleted },
      });
    },
  );

  return router;
}
