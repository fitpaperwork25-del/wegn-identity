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
 * The token only ever proves email + a resolved destination + short
 * expiry. It carries no capability beyond "let this browser attempt
 * sign-in as this email on this product, then land on this specific
 * URL" - the target product still generates its own real Supabase Auth
 * session via its own admin API, using its own already-provisioned
 * service-role key. This function never touches any product's users.
 *
 * Destination resolution (added for the WEGN Restaurants Launch audit,
 * REQUIRED businessId added after that fix's own acceptance test
 * failed): reuses wegn_product_destinations/wegn_business_product_links -
 * the same tables business-portfolio-v1's own resolveLaunch() already
 * reads for the business-scoped Launch button - instead of each
 * product's sso-login hardcoding its own redirect target. businessId is
 * mandatory and is only honored after confirming BOTH an active
 * wegn_business_memberships row ties the caller's own account to that
 * business AND an active wegn_business_product_links row ties that
 * specific business to this product - so a caller can never resolve a
 * deep link into a business they don't belong to, and can never launch
 * into a product connection that belongs to a DIFFERENT business on the
 * same account.
 *
 * The account-level account_links table (Phase A signup linking) is
 * deliberately never consulted here anymore. It answers "does this
 * WEGN Account have any login at all on this product" - a question
 * that says nothing about which of the account's businesses that login
 * actually belongs to, and was exactly the mechanism that let Launch
 * silently open one business's owner's OTHER, unrelated product login
 * (see the WEGN Restaurants Launch audit's second, failed acceptance
 * test - launching from "Dukan Bahrey" landed on the unrelated
 * "QR-Wegn HQ" business because both merely traced back to the same
 * WEGN Account, not because they were actually linked to each other).
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

  let body: { productKey?: string; businessId?: string };
  try {
    body = await req.json();
  } catch {
    return finish(400, "validation_failed", { error: "Invalid JSON body" }, { errorCode: "invalid_json" });
  }
  const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
  const businessId = typeof body.businessId === "string" && body.businessId.trim() ? body.businessId.trim() : "";
  const credentialEnvName = PRODUCT_CREDENTIAL_ENV[productKey];
  if (!credentialEnvName) {
    return finish(400, "validation_failed", { error: "Unknown or missing productKey" }, { productKey, errorCode: "unknown_product_key" });
  }
  if (!businessId) {
    return finish(400, "validation_failed", { error: "businessId is required" }, { productKey, errorCode: "missing_business_id" });
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

  const { data: destinationRow, error: destinationErr } = await admin
    .from("wegn_product_destinations")
    .select("base_url, url_template")
    .eq("product_key", productKey)
    .maybeSingle();
  if (destinationErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { productKey, errorCode: "destination_lookup_failed", wegnAccountId: account.id });
  }
  if (!destinationRow) {
    return finish(500, "internal_error", { error: "No launch destination configured for this product" }, { productKey, errorCode: "destination_not_configured", wegnAccountId: account.id });
  }

  const nowIso = new Date().toISOString();
  const { data: membership, error: membershipErr } = await admin
    .from("wegn_business_memberships")
    .select("id")
    .eq("wegn_account_id", account.id)
    .eq("wegn_business_id", businessId)
    .eq("access_status", "active")
    .lte("valid_from", nowIso)
    .or(`valid_until.is.null,valid_until.gt.${nowIso}`)
    .maybeSingle();
  if (membershipErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { productKey, errorCode: "membership_lookup_failed", wegnAccountId: account.id });
  }
  if (!membership) {
    return finish(403, "forbidden", { error: "This WEGN Account does not have access to this business" }, { productKey, errorCode: "business_forbidden", wegnAccountId: account.id });
  }

  const { data: businessLink, error: businessLinkErr } = await admin
    .from("wegn_business_product_links")
    .select("external_business_id")
    .eq("wegn_business_id", businessId)
    .eq("product_key", productKey)
    .eq("link_status", "active")
    .maybeSingle();
  if (businessLinkErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { productKey, errorCode: "business_link_lookup_failed", wegnAccountId: account.id });
  }
  if (!businessLink) {
    return finish(404, "not_connected", { error: "This business is not connected to this product" }, { productKey, errorCode: "business_not_connected", wegnAccountId: account.id });
  }
  const externalBusinessId: string = businessLink.external_business_id;

  let destination: string;
  if (!destinationRow.url_template) {
    destination = destinationRow.base_url;
  } else if (externalBusinessId) {
    destination = destinationRow.url_template.replaceAll("{externalBusinessId}", externalBusinessId);
  } else {
    return finish(409, "unavailable", { error: "This product requires a specific business to launch into" }, { productKey, errorCode: "business_required", wegnAccountId: account.id });
  }

  const productSecret = Deno.env.get(credentialEnvName);
  if (!productSecret) {
    return finish(500, "internal_error", { error: "Server is not configured (missing product credential)" }, { productKey, errorCode: "missing_product_credential", wegnAccountId: account.id });
  }

  const payload = JSON.stringify({ email, destination, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  const encodedPayload = base64UrlEncode(payload);
  const signature = await hmacSha256Hex(productSecret, encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  return finish(200, "success", { ok: true, token }, { productKey, wegnAccountId: account.id });
});
