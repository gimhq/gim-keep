import type { Bytes, GimAuthEnv } from "./gim.auth";
import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, TAGS } from "@/shared/lib/openapi";
import { gimAuthRequired } from "./gim.auth";
import {
  createReport,
  deleteUserData,
  getSlot,
  MAX_SLOT_LENGTH,
  putSlot,
  REPORT_REASONS,
} from "./gim.service";

const SLOT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER_ID_RE = /^u[a-z2-7]{55}$/;
const BASE64_RE = /^[A-Z0-9+/]*={0,2}$/i;

const slotSchema = z.object({
  version: z.number().int().positive(),
  data: z.string(),
});

const putSlotSchema = z.object({
  /** The version the client last read; 0 creates the slot. */
  version: z.number().int().min(0),
  data: z.string().max(MAX_SLOT_LENGTH).regex(BASE64_RE),
});

const reportSchema = z.object({
  reportedUserId: z.string().regex(USER_ID_RE),
  reason: z.enum(REPORT_REASONS),
  note: z.string().max(1000).optional(),
  messages: z.array(z.object({
    messageId: z.string().min(1).max(128),
    senderUserId: z.string().regex(USER_ID_RE),
    sentAtMs: z.number().int().min(0),
    text: z.string().max(4000),
  })).max(50),
});

/** Parses the signed body (already read by `gimAuthRequired`). */
function signedJson<T>(body: Bytes, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  }
  catch {
    throw new ValidationError("Body is not JSON", null);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError("Invalid request body", parsed.error.issues);
  return parsed.data;
}

function slotName(name: string): string {
  if (!SLOT_NAME_RE.test(name))
    throw new NotFoundError("Slot", name);
  return name;
}

const SIGNED = "Signed with the user's root key: `Gim-Key`, `Gim-Timestamp` and `Gim-Signature` headers (gim-core docs/identity.md \"Root-signed requests\").";

/** Routes for gim clients, on the raw API: `/api/raw/gim/v1/*`. */
export function gimRawRoutes() {
  const router = new Hono<GimAuthEnv>();
  router.use("/gim/v1/*", gimAuthRequired);

  router.get(
    "/gim/v1/storage/:name",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Read a storage slot",
      description: `The sealed slot and its version. ${SIGNED}`,
      responses: {
        ...jsonOk(slotSchema, "Slot"),
        ...errors(401, 404),
      },
    }),
    async (c) => {
      const name = slotName(c.req.param("name"));
      const slot = await getSlot(c.get("db"), c.get("gimUserId"), name);
      if (!slot)
        throw new NotFoundError("Slot", name);
      return c.json({ success: true, data: slot });
    },
  );

  router.put(
    "/gim/v1/storage/:name",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Write a storage slot",
      description: `Writes the next version if the slot is still at \`version\` (0 creates it); otherwise 409 \`VERSION_CONFLICT\` with the current version in \`details.version\`. ${SIGNED}`,
      responses: {
        ...jsonOk(z.object({
          version: z.number().int(),
        }), "New version"),
        ...errors(401, 404, 409, 422),
      },
    }),
    async (c) => {
      const name = slotName(c.req.param("name"));
      const body = signedJson(c.get("gimBody"), putSlotSchema);
      const version = await putSlot(c.get("db"), c.get("gimUserId"), name, body.version, body.data);
      return c.json({
        success: true,
        data: { version },
      });
    },
  );

  router.post(
    "/gim/v1/reports",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Report a user",
      description: `Files an abuse report with the messages the reporter chose, in plaintext. A replayed request returns the same report. ${SIGNED}`,
      responses: {
        ...jsonCreated(z.object({
          id: z.string(),
        }), "Report"),
        ...errors(401, 422, 429),
      },
    }),
    async (c) => {
      const body = signedJson(c.get("gimBody"), reportSchema);
      const id = await createReport(c.get("db"), {
        ...body,
        reporterId: c.get("gimUserId"),
        requestDigest: c.get("gimRequestDigest"),
      });
      return c.json({
        success: true,
        data: { id },
      }, 201);
    },
  );

  router.delete(
    "/gim/v1/me",
    describeRoute({
      tags: [TAGS.Gim],
      summary: "Delete the account's data",
      description: `Deletes every storage slot of the signing user (account deletion). Reports stay. ${SIGNED}`,
      responses: {
        ...jsonOk(z.object({
          deletedSlots: z.number().int(),
        }), "Deleted"),
        ...errors(401),
      },
    }),
    async (c) => {
      const deletedSlots = await deleteUserData(c.get("db"), c.get("gimUserId"));
      return c.json({
        success: true,
        data: { deletedSlots },
      });
    },
  );

  return router;
}
