import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { listReports, REPORT_STATUSES, setReportStatus } from "./gim.service";

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

/** The moderators' report inbox (admins, browser session). */
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

  return router;
}
