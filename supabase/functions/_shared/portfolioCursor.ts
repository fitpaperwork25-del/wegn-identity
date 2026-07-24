import { API_VERSION } from "./portfolioContract.ts";

export const API_MAJOR_VERSION = "v1";
export const CURSOR_TTL_MS = 15 * 60 * 1000;

export type CursorSortTuple = {
  rank: number;
  latestAttentionAt: string | null;
  normalizedName: string;
  id: string;
};

export type CursorPayload = {
  apiMajorVersion: string;
  accountId: string;
  limit: number;
  lastBusinessId: string;
  lastSort: CursorSortTuple;
  expiresAt: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function createPortfolioCursor(secret: string, payload: Omit<CursorPayload, "apiMajorVersion">): Promise<string> {
  const complete: CursorPayload = { apiMajorVersion: API_MAJOR_VERSION, ...payload };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(complete)));
  const key = await importHmacKey(secret, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `${encoded}.${bytesToBase64Url(signature)}`;
}

export async function parsePortfolioCursor(params: {
  secret: string;
  value: string;
  accountId: string;
  limit: number;
  nowMs?: number;
  expectedMajorVersion?: string;
}): Promise<CursorPayload | null> {
  const [encoded, signature, extra] = params.value.split(".");
  if (!encoded || !signature || extra) return null;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  const key = await importHmacKey(params.secret, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, new TextEncoder().encode(encoded).buffer as ArrayBuffer)) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as CursorPayload;
    const expectedVersion = params.expectedMajorVersion ?? API_MAJOR_VERSION;
    const nowMs = params.nowMs ?? Date.now();
    if (parsed.apiMajorVersion !== expectedVersion
      || parsed.accountId !== params.accountId
      || parsed.limit !== params.limit
      || parsed.expiresAt < nowMs
      || !parsed.lastBusinessId
      || !validSortTuple(parsed.lastSort)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validSortTuple(tuple: CursorSortTuple | null | undefined): tuple is CursorSortTuple {
  return !!tuple
    && Number.isInteger(tuple.rank)
    && (tuple.latestAttentionAt === null || typeof tuple.latestAttentionAt === "string")
    && typeof tuple.normalizedName === "string"
    && typeof tuple.id === "string";
}

export function resolveCursorStartIndex<T extends { id: string; _sort: CursorSortTuple }>(
  cursor: CursorPayload,
  businesses: T[],
): number | null {
  const index = businesses.findIndex((business) => business.id === cursor.lastBusinessId);
  if (index < 0) return null;
  const current = businesses[index];
  if (JSON.stringify(current._sort) !== JSON.stringify(cursor.lastSort)) return null;
  return index + 1;
}

// Exported only so contract tests can assert the body schema revision remains
// independent from the major compatibility boundary.
export const CURSOR_SCHEMA_VERSION = API_VERSION;
