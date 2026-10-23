// Root-signed requests (gim-core docs/identity.md "Root-signed requests"):
// the client signs method, path, timestamp and body digest with the user's
// root key; the user id is derived from the key, so no account is stored.
import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { UnauthorizedError } from "@/shared/lib/errors";

export const ROOT_REQUEST_CONTEXT = "gim/root-request/v1";
export const ROOT_REQUEST_MAX_SKEW_MS = 5 * 60 * 1000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const encoder = new TextEncoder();

/** Bytes backed by a plain `ArrayBuffer`, as WebCrypto takes them. */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface GimAuthEnv extends AppEnv {
  Variables: AppEnv["Variables"] & {
    gimUserId: string;
    gimBody: Bytes;
    gimRequestDigest: string;
  };
}

export function base64UrlDecode(text: string): Bytes | null {
  if (!/^[\w-]*$/.test(text))
    return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
  }
  catch {
    return null;
  }
}

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0)
    out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** `"u" + base32(0x12 0x20 || SHA-256(root public key))`. */
export async function userIdOf(publicKey: Bytes): Promise<string> {
  const multihash = new Uint8Array(34);
  multihash.set([0x12, 0x20]);
  multihash.set(await sha256(publicKey), 2);
  return `u${base32(multihash)}`;
}

/** The exact signed input: `context || 0x00 || tbs`. */
export async function signingInput(method: string, path: string, timestampMs: string, body: Bytes): Promise<Bytes> {
  const tbs = `${method}\n${path}\n${timestampMs}\n${hex(await sha256(body))}`;
  return encoder.encode(`${ROOT_REQUEST_CONTEXT}\0${tbs}`);
}

export interface SignedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Bytes;
  readonly key: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

/**
 * The user id of a correctly signed, current request, or `null`. The
 * timestamp must be canonical decimal and within the skew of `nowMs`.
 */
export async function verifyRequest(request: SignedRequest, nowMs: number): Promise<string | null> {
  const { key, timestamp, signature } = request;
  if (!key || !timestamp || !signature || !/^(?:0|[1-9]\d{0,15})$/.test(timestamp))
    return null;
  if (Math.abs(Number(timestamp) - nowMs) > ROOT_REQUEST_MAX_SKEW_MS)
    return null;
  const publicKey = base64UrlDecode(key);
  const sig = base64UrlDecode(signature);
  if (publicKey?.length !== 32 || sig?.length !== 64)
    return null;
  let verified = false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const input = await signingInput(request.method, request.path, timestamp, request.body);
    verified = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, input);
  }
  catch {
    return null;
  }
  return verified ? userIdOf(publicKey) : null;
}

/**
 * Requires a root-signed request. Reads the body once (the signature covers
 * its bytes) and exposes it as `gimBody`, with the user id as `gimUserId`.
 */
export const gimAuthRequired = createMiddleware<GimAuthEnv>(async (c, next) => {
  const url = new URL(c.req.url);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const signature = c.req.header("gim-signature");
  const userId = await verifyRequest({
    method: c.req.method.toUpperCase(),
    path: `${url.pathname}${url.search}`,
    body,
    key: c.req.header("gim-key"),
    timestamp: c.req.header("gim-timestamp"),
    signature,
  }, Date.now());
  if (!userId)
    throw new UnauthorizedError("Invalid or expired request signature");
  c.set("gimUserId", userId);
  c.set("gimBody", body);
  c.set("gimRequestDigest", hex(await sha256(encoder.encode(signature!))));
  return next();
});
