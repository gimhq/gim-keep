import type { Bytes } from "./gim.auth";
import type { AppDeps } from "@/app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { buildOuterApp, buildRawApp } from "@/app";
import { createDb } from "@/db";
import { __resetRateLimitForTests } from "@/shared/middleware/rate-limit";
import vectors from "./fixtures/request.json";
import { signingInput, userIdOf, verifyRequest } from "./gim.auth";
import { listReports, MAX_SLOTS_PER_USER, putSlot, setReportStatus } from "./gim.service";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;
const encoder = new TextEncoder();

function fromHex(hex: string): Bytes {
  return Uint8Array.from(hex.match(/../g) ?? [], b => Number.parseInt(b, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A user holding the Ed25519 root key of `seed`. */
async function rootUser(seed: Bytes) {
  const pkcs8 = new Uint8Array([...fromHex("302e020100300506032b657004220420"), ...seed]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  return {
    userId: await userIdOf(publicKey),
    async headers(method: string, path: string, body: string, timestampMs = Date.now()) {
      const input = await signingInput(method, path, String(timestampMs), encoder.encode(body));
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, input));
      return {
        "gim-key": base64Url(publicKey),
        "gim-timestamp": String(timestampMs),
        "gim-signature": base64Url(signature),
      };
    },
  };
}

describe("root-signed request vectors (gim-core tests/vectors/request.json)", () => {
  for (const vector of vectors.cases) {
    test(`${vector.method} ${vector.path}`, async () => {
      const body = fromHex(vector.body);
      const input = await signingInput(vector.method, vector.path, String(vector.timestamp_ms), body);
      expect(toHex(input)).toBe(vector.message);
      const request = {
        method: vector.method,
        path: vector.path,
        body,
        key: vector.gim_key,
        timestamp: String(vector.timestamp_ms),
        signature: vector.gim_signature,
      };
      expect(await verifyRequest(request, vector.timestamp_ms)).toBe(vector.user_id);
      // Any changed part, or a stale clock, fails.
      expect(await verifyRequest({ ...request, path: `${vector.path}x` }, vector.timestamp_ms)).toBeNull();
      expect(await verifyRequest({ ...request, body: encoder.encode("x") }, vector.timestamp_ms)).toBeNull();
      expect(await verifyRequest({ ...request, method: "POST" }, vector.timestamp_ms)).toBeNull();
      expect(await verifyRequest(request, vector.timestamp_ms + 5 * 60 * 1000 + 1)).toBeNull();
      expect(await verifyRequest({ ...request, timestamp: `0${vector.timestamp_ms}` }, vector.timestamp_ms)).toBeNull();
      expect(await verifyRequest({ ...request, key: undefined }, vector.timestamp_ms)).toBeNull();
    });
  }

  test("the derived user id matches", async () => {
    const user = await rootUser(fromHex(vectors.cases[0]!.root_seed));
    expect(user.userId).toBe(vectors.cases[0]!.user_id);
  });
});

describe("gim raw routes", () => {
  let db: AppDatabase;
  let dir: string;
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    __resetRateLimitForTests();
    dir = mkdtempSync(resolve(tmpdir(), "gim-"));
    db = await createDb(resolve(dir, "app.db"));
    const config = {
      NODE_ENV: "test",
      TRUST_PROXY: false,
      BASE_PATH: "",
      APP_URL: "https://app.example.test",
      RAW_API_RATE_LIMIT_PER_MINUTE: 1000,
    } as unknown as Config;
    const deps: AppDeps = {
      config,
      db,
      logger: noop,
      encryption: { isSystemLocked: () => false } as unknown as AppDeps["encryption"],
    };
    app = buildOuterApp(new Hono<AppEnv>(), config, buildRawApp(deps));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(user: Awaited<ReturnType<typeof rootUser>>, method: string, path: string, body = "") {
    const headers = await user.headers(method, path, body);
    return app.request(path, body ? { method, headers, body } : { method, headers });
  }

  test("a slot is created, read and replaced version by version", async () => {
    const alice = await rootUser(new Uint8Array(32).fill(1));
    const path = "/api/raw/gim/v1/storage/settings";
    expect((await call(alice, "GET", path)).status).toBe(404);

    const put = await call(alice, "PUT", path, JSON.stringify({ version: 0, data: "AAEC" }));
    expect(put.status).toBe(200);
    expect((await put.json()).data).toEqual({ version: 1 });
    expect((await (await call(alice, "GET", path)).json()).data).toEqual({ version: 1, data: "AAEC" });

    // A writer that did not see version 1 is refused with the current one.
    const stale = await call(alice, "PUT", path, JSON.stringify({ version: 0, data: "AwQF" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: "VERSION_CONFLICT", details: { version: 1 } });
    const next = await call(alice, "PUT", path, JSON.stringify({ version: 1, data: "AwQF" }));
    expect((await next.json()).data).toEqual({ version: 2 });

    // Slots are per user.
    const bob = await rootUser(new Uint8Array(32).fill(2));
    expect((await call(bob, "GET", path)).status).toBe(404);
  });

  test("unsigned, forged and malformed requests are refused", async () => {
    const alice = await rootUser(new Uint8Array(32).fill(1));
    const path = "/api/raw/gim/v1/storage/settings";
    expect((await app.request(path)).status).toBe(401);
    // Signed for another path.
    const headers = await alice.headers("GET", "/api/raw/gim/v1/storage/other", "");
    expect((await app.request(path, { headers })).status).toBe(401);
    // Signed long ago.
    const old = await alice.headers("GET", path, "", Date.now() - 10 * 60 * 1000);
    expect((await app.request(path, { headers: old })).status).toBe(401);
    expect((await call(alice, "GET", "/api/raw/gim/v1/storage/Bad%20Name")).status).toBe(404);
    expect((await call(alice, "PUT", path, "{not json")).status).toBe(422);
    expect((await call(alice, "PUT", path, JSON.stringify({ version: 0, data: "not base64!" }))).status).toBe(422);
  });

  test("a report is stored once and reaches the inbox", async () => {
    const alice = await rootUser(new Uint8Array(32).fill(1));
    const mallory = await rootUser(new Uint8Array(32).fill(3));
    const path = "/api/raw/gim/v1/reports";
    const body = JSON.stringify({
      reportedUserId: mallory.userId,
      reason: "harassment",
      note: "keeps writing",
      messages: [{ messageId: "m1", senderUserId: mallory.userId, sentAtMs: 1, text: "go away" }],
    });
    const headers = await alice.headers("POST", path, body);
    const first = await app.request(path, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    const { id } = (await first.json()).data;
    // The same signed request again adds nothing.
    const replay = await app.request(path, { method: "POST", headers, body });
    expect((await replay.json()).data.id).toBe(id);

    const open = await listReports(db, "open", 10);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id, reporterId: alice.userId, reportedUserId: mallory.userId, reason: "harassment" });
    expect(open[0]!.messages[0]!.text).toBe("go away");
    expect(await setReportStatus(db, id, "resolved", "moderator")).toBe(true);
    expect(await listReports(db, "open", 10)).toHaveLength(0);
    expect((await listReports(db, "resolved", 10))[0]!.resolvedBy).toBe("moderator");
    expect(await setReportStatus(db, "missing", "resolved", "moderator")).toBe(false);

    const invalid = JSON.stringify({ reportedUserId: "bob", reason: "harassment", messages: [] });
    expect((await call(alice, "POST", path, invalid)).status).toBe(422);
  });

  test("deleting the account removes its slots only", async () => {
    const alice = await rootUser(new Uint8Array(32).fill(1));
    const bob = await rootUser(new Uint8Array(32).fill(2));
    const path = "/api/raw/gim/v1/storage/settings";
    await call(alice, "PUT", path, JSON.stringify({ version: 0, data: "AA==" }));
    await call(bob, "PUT", path, JSON.stringify({ version: 0, data: "AA==" }));
    const deleted = await call(alice, "DELETE", "/api/raw/gim/v1/me");
    expect((await deleted.json()).data).toEqual({ deletedSlots: 1 });
    expect((await call(alice, "GET", path)).status).toBe(404);
    expect((await call(bob, "GET", path)).status).toBe(200);
  });

  test("a user has a bounded number of slots", async () => {
    for (let i = 0; i < MAX_SLOTS_PER_USER; i++)
      await putSlot(db, "u1", `s${i}`, 0, "AA==");
    await expect(putSlot(db, "u1", "one-more", 0, "AA==")).rejects.toMatchObject({ code: "TOO_MANY_SLOTS" });
    // An existing slot still updates.
    expect(await putSlot(db, "u1", "s0", 1, "AQ==")).toBe(2);
  });
});
