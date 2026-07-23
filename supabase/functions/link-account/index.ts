import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeOperation, authorizeProductKey } from "../_shared/credentialRegistry.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Task 1 foundation capability - the only thing this service does so
 * far. Links an existing product's own account (its own auth_user_id)
 * to a WEGN Account, creating the WEGN Account if this email has never
 * been seen before. Does not touch, modify, or read anything in the
 * calling product's own database - the caller supplies its own
 * auth_user_id and email; this function never verifies them against
 * that product directly (that would require a cross-project connection,
 * exactly what WSMS's own architecture deliberately avoids - see
 * docs/WSMS_DEPENDENCY_MAP.md in wegn-platform-admin. The calling
 * product is responsible for only ever invoking this from its own
 * server-side code, after its own auth has already verified the caller).
 *
 * Authorization (Sprint 2 Task 5): a per-consumer scoped credential via
 * ../_shared/credentialRegistry.ts - each credential is restricted to
 * link-account only and to its own productKey. The old shared bootstrap
 * secret (IDENTITY_SERVICE_SECRET) is no longer accepted - every
 * consumer has cut over and the secret itself has been deleted.
 *
 * Idempotent by design, not just by convention: a repeated call for the
 * same (productKey, productAuthUserId) pair returns the existing link
 * (alreadyLinked: true) instead of erroring - safe to retry after a
 * network failure, mirroring wegn-wsms's self-register-subscription
 * exactly.
 *
 * Sprint 2 Task 6B: every outcome (success, invalid credential, forbidden
 * operation, productKey mismatch, validation failure, internal error) is
 * both structured-logged and written to identity_audit_log, tagged with
 * a request ID returned to the caller. Audit writes are best-effort -
 * see _shared/auditLog.ts - and never block this function's own
 * response.
 *
 * Explicitly, deliberately does NOT: create Business Membership, create
 * Staff or Partner records, replace or modify any product's own login,
 * issue any cross-product session or token, or send any invitation.
 * Those are later, separately approved tasks.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
};

function jsonResponse(requestId: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", [REQUEST_ID_HEADER]: requestId },
  });
}

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    logEvent("error", { requestId, operation: "link-account", outcome: "internal_error", errorCode: "missing_config", durationMs: Date.now() - startedAt });
    return jsonResponse(requestId, { error: "Server is not configured (missing required secrets)" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  function finish(status: number, outcome: string, body: Record<string, unknown>, extra?: {
    consumer?: string | null; productKey?: string | null; errorCode?: string | null;
    wegnAccountId?: string | null; accountLinkId?: string | null;
  }): Response {
    const durationMs = Date.now() - startedAt;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId, operation: "link-account", outcome,
      consumer: extra?.consumer, productKey: extra?.productKey, errorCode: extra?.errorCode, durationMs,
    });
    // Fire-and-forget from this function's own perspective too - never
    // await-block the response on the audit write's own latency.
    void writeAuditLog(admin, {
      requestId, operation: "link-account", outcome,
      consumer: extra?.consumer ?? null, productKey: extra?.productKey ?? null,
      errorCode: extra?.errorCode ?? null, wegnAccountId: extra?.wegnAccountId ?? null, accountLinkId: extra?.accountLinkId ?? null,
    });
    return jsonResponse(requestId, body, status);
  }

  let body: { secret?: string; productKey?: string; productAuthUserId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return finish(400, "validation_failed", { error: "Invalid JSON body" }, { errorCode: "invalid_json" });
  }

  const secret = typeof body.secret === "string" ? body.secret : "";
  const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
  const productAuthUserId = typeof body.productAuthUserId === "string" ? body.productAuthUserId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const authz = authorizeOperation(secret, "link-account");
  if (!authz.ok) {
    const outcome = authz.status === 401 ? "invalid_credential" : "forbidden_operation";
    return finish(authz.status, outcome, { error: authz.error }, { consumer: authz.entry?.consumer, productKey, errorCode: outcome });
  }
  if (!productKey || !productAuthUserId || !email) {
    return finish(400, "validation_failed",
      { error: "productKey, productAuthUserId, and email are required" },
      { consumer: authz.entry.consumer, productKey, errorCode: "missing_fields" });
  }
  const scopeCheck = authorizeProductKey(authz.entry, productKey);
  if (!scopeCheck.ok) {
    return finish(scopeCheck.status, "product_key_mismatch", { error: scopeCheck.error },
      { consumer: authz.entry.consumer, productKey, errorCode: "product_key_mismatch" });
  }

  const consumer = authz.entry.consumer;

  // Idempotency check first: if this exact (product, product_auth_user_id)
  // pair is already linked, return the existing link rather than
  // attempting an insert that would fail the UNIQUE constraint.
  const { data: existingLink, error: existingLinkErr } = await admin
    .from("account_links")
    .select("id, wegn_account_id")
    .eq("product_key", productKey)
    .eq("product_auth_user_id", productAuthUserId)
    .maybeSingle();
  if (existingLinkErr) {
    return finish(500, "internal_error", { error: "Lookup failed" },
      { consumer, productKey, errorCode: "existing_link_lookup_failed" });
  }
  if (existingLink) {
    return finish(200, "success", { ok: true, alreadyLinked: true, wegnAccountId: existingLink.wegn_account_id },
      { consumer, productKey, wegnAccountId: existingLink.wegn_account_id, accountLinkId: existingLink.id });
  }

  // Find or create the WEGN Account by email. Two products' owners who
  // share an email become the same WEGN Account, by design - that is
  // the entire point of this service.
  const { data: existingAccount, error: accountLookupErr } = await admin
    .from("wegn_accounts")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (accountLookupErr) {
    return finish(500, "internal_error", { error: "Lookup failed" },
      { consumer, productKey, errorCode: "account_lookup_failed" });
  }

  let wegnAccountId = existingAccount?.id as string | undefined;
  if (!wegnAccountId) {
    const { data: newAccount, error: createErr } = await admin
      .from("wegn_accounts")
      .insert({ email })
      .select("id")
      .single();
    if (createErr) {
      return finish(500, "internal_error", { error: "Account creation failed" },
        { consumer, productKey, errorCode: "account_creation_failed" });
    }
    wegnAccountId = newAccount.id;
  }

  const { data: newLink, error: linkErr } = await admin
    .from("account_links")
    .insert({ wegn_account_id: wegnAccountId, product_key: productKey, product_auth_user_id: productAuthUserId })
    .select("id")
    .single();
  if (linkErr) {
    return finish(500, "internal_error", { error: "Link creation failed" },
      { consumer, productKey, wegnAccountId, errorCode: "link_creation_failed" });
  }

  return finish(200, "success", { ok: true, alreadyLinked: false, wegnAccountId },
    { consumer, productKey, wegnAccountId, accountLinkId: newLink.id });
});
