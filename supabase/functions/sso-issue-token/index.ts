import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Cross-product SSO bridge: the "later, separately approved task" that
 * link-account's own header comment flagged as explicitly out of scope
 * for that function - approved now. Lets a WEGN Home session obtain a
 * short-lived, product-specific token that proves "this email is this
 * WEGN Account, and this WEGN Account is linked to that product,"
 * without wegn-identity ever holding another product's service-role
 * key. Same end-user auth model as dashboard-summary
 * (verifyUserAuth against this project's own Auth), not
 * credentialRegistry.ts's per-consumer service secrets.
 *
 * Signing reuses the exact same IDENTITY_CREDENTIAL_* secrets already
 * held by both sides for link-account (see credentialRegistry.ts) -
 * deliberately not a new secret. Each product already has this value
 * as its own IDENTITY_CREDENTIAL env var, so it can verify the HMAC
 * itself with no new credential distribution.
 *
 * The token only ever proves email + short expiry. It carries no
 * capability beyond "let this browser attempt sign-in as this email on
 * this product" - the target product still generates its own real
 * Supabase Auth session via its own admin API, using its own
 * already-provisioned service-role key. This function never touches
 * any product's users.
 */

const PRODUCT_CREDENTIAL_ENV: Record<string, string> = {
  qrwegn: "IDENTITY_CREDENTIAL_QRWEGN",
  "wegn-store": "IDENTITY_CREDENTIAL_WEGN_STORE",
  qrbooker: "IDENTITY_CREDENTIAL_QRBOOKER",
};

const TOKEN_TTL_SECONDS = 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

function jsonResponse(requestId: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    logEvent("error", { requestId, operation: "sso-issue-token", outcome: "internal_error", errorCode: "missing_config", durationMs: Date.now() - startedAt });
    return jsonResponse(requestId, { error: "Server is not configured (missing required secrets)" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  function finish(status: number, outcome: string, body: Record<string, unknown>, extra?: {
    productKey?: string | null; errorCode?: string | null; wegnAccountId?: string | null;
  }): Response {
    const durationMs = Date.now() - startedAt;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId, operation: "sso-issue-token", outcome, consumer: "wegn-home",
      productKey: extra?.productKey, errorCode: extra?.errorCode, durationMs,
    });
    void writeAuditLog(admin, {
      requestId, operation: "sso-issue-token", outcome, consumer: "wegn-home",
      productKey: extra?.productKey ?? null, errorCode: extra?.errorCode ?? null, wegnAccountId: extra?.wegnAccountId ?? null,
    });
    return jsonResponse(requestId, body, status);
  }

  const verified = await verifyUserAuth({ supabaseUrl, supabaseAnonKey, authorizationHeader: req.headers.get("Authorization") });
  if (!verified || !verified.email) {
    return finish(401, "invalid_credential", { error: "Not authenticated" }, { errorCode: "not_authenticated" });
  }
  const email = verified.email.trim().toLowerCase();

  let body: { productKey?: string };
  try {
    body = await req.json();
  } catch {
    return finish(400, "validation_failed", { error: "Invalid JSON body" }, { errorCode: "invalid_json" });
  }
  const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
  const credentialEnvName = PRODUCT_CREDENTIAL_ENV[productKey];
  if (!credentialEnvName) {
    return finish(400, "validation_failed", { error: "Unknown or missing productKey" }, { productKey, errorCode: "unknown_product_key" });
  }

  const { data: account, error: accountErr } = await admin
    .from("wegn_accounts")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (accountErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { productKey, errorCode: "account_lookup_failed" });
  }
  if (!account) {
    return finish(404, "not_found", { error: "No WEGN Account for this session" }, { productKey, errorCode: "account_not_found" });
  }

  const { data: link, error: linkErr } = await admin
    .from("account_links")
    .select("id")
    .eq("wegn_account_id", account.id)
    .eq("product_key", productKey)
    .maybeSingle();
  if (linkErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { productKey, errorCode: "link_lookup_failed", wegnAccountId: account.id });
  }
  if (!link) {
    return finish(404, "not_connected", { error: "This WEGN Account is not connected to this product" }, { productKey, errorCode: "not_connected", wegnAccountId: account.id });
  }

  const productSecret = Deno.env.get(credentialEnvName);
  if (!productSecret) {
    return finish(500, "internal_error", { error: "Server is not configured (missing product credential)" }, { productKey, errorCode: "missing_product_credential", wegnAccountId: account.id });
  }

  const payload = JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  const encodedPayload = base64UrlEncode(payload);
  const signature = await hmacSha256Hex(productSecret, encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  return finish(200, "success", { ok: true, token }, { productKey, wegnAccountId: account.id });
});
