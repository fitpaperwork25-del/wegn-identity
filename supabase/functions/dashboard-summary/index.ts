import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyUserAuth } from "../_shared/verifyUserAuth.ts";
import { resolveRequestId, REQUEST_ID_HEADER } from "../_shared/requestId.ts";
import { logEvent } from "../_shared/logger.ts";
import { writeAuditLog } from "../_shared/auditLog.ts";

/**
 * Sprint 4A - WEGN Home Dashboard, Phase 1. Read-only. The first Identity
 * operation authenticated by a real end user's own session (via
 * verifyUserAuth.ts) rather than a per-consumer service secret - see that
 * file's own header. This is additive: every existing operation
 * (link-account, list-accounts, health-summary) and their credential-based
 * authorization is completely untouched.
 *
 * Finds-or-creates the caller's wegn_accounts row by their authenticated
 * email, using the exact same logic as link-account (see that function's
 * own comment on why: two products' owners who share an email are the
 * same WEGN Account, by design). A first-ever WEGN Platform login for an
 * email that has never linked any product yet still gets a real account
 * row here, with zero linked products - that is a legitimate, correctly
 * empty state, not an error.
 *
 * Returns only what genuinely exists today: account identity and
 * connected-products (from account_links). Does NOT return businesses,
 * subscriptions, or partner data - no cross-product read endpoint exists
 * yet for those (see docs/WSMS_IDENTITY_RELATIONSHIP_DECISION.md and the
 * Sprint 4A final report's Phase 2 recommendations). The frontend is
 * responsible for rendering clearly-marked placeholders for anything this
 * response does not include.
 */

const KNOWN_PRODUCT_KEYS = ["qrwegn", "wegn-store", "qrbooker"] as const;

// Unlike every other Identity operation (called via raw fetch, with a
// service secret, by another product's server), this one is called
// directly by a browser via supabase.functions.invoke(), which attaches
// its own apikey/x-client-info headers automatically - both must be
// allowed here or the browser blocks the request at the CORS preflight
// before it's ever sent.
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

serve(async (req: Request) => {
  const requestId = resolveRequestId(req);
  const startedAt = Date.now();

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse(requestId, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    logEvent("error", { requestId, operation: "dashboard-summary", outcome: "internal_error", errorCode: "missing_config", durationMs: Date.now() - startedAt });
    return jsonResponse(requestId, { error: "Server is not configured (missing required secrets)" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  function finish(status: number, outcome: string, body: Record<string, unknown>, extra?: { errorCode?: string | null; wegnAccountId?: string | null }): Response {
    const durationMs = Date.now() - startedAt;
    logEvent(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId, operation: "dashboard-summary", outcome, consumer: "wegn-home", errorCode: extra?.errorCode, durationMs,
    });
    void writeAuditLog(admin, {
      requestId, operation: "dashboard-summary", outcome, consumer: "wegn-home",
      errorCode: extra?.errorCode ?? null, wegnAccountId: extra?.wegnAccountId ?? null,
    });
    return jsonResponse(requestId, body, status);
  }

  const verified = await verifyUserAuth({
    supabaseUrl, supabaseAnonKey,
    authorizationHeader: req.headers.get("Authorization"),
  });
  if (!verified || !verified.email) {
    return finish(401, "invalid_credential", { error: "Not authenticated" }, { errorCode: "not_authenticated" });
  }
  const email = verified.email.trim().toLowerCase();

  // Find-or-create by email - identical logic to link-account, see that
  // function's own comment. A WEGN Home login is not itself a product
  // link, so no account_links row is created here - only wegn_accounts.
  const { data: existingAccount, error: accountLookupErr } = await admin
    .from("wegn_accounts")
    .select("id, email, status, created_at")
    .eq("email", email)
    .maybeSingle();
  if (accountLookupErr) {
    return finish(500, "internal_error", { error: "Lookup failed" }, { errorCode: "account_lookup_failed" });
  }

  let account = existingAccount;
  if (!account) {
    const { data: newAccount, error: createErr } = await admin
      .from("wegn_accounts")
      .insert({ email })
      .select("id, email, status, created_at")
      .single();
    if (createErr) {
      return finish(500, "internal_error", { error: "Account creation failed" }, { errorCode: "account_creation_failed" });
    }
    account = newAccount;
  }

  const { data: links, error: linksErr } = await admin
    .from("account_links")
    .select("product_key, created_at")
    .eq("wegn_account_id", account.id);
  if (linksErr) {
    return finish(500, "internal_error", { error: "Read failed" }, { errorCode: "links_read_failed", wegnAccountId: account.id });
  }

  const linkedByProduct = new Map((links ?? []).map((l) => [l.product_key, l.created_at]));
  const connectedProducts = KNOWN_PRODUCT_KEYS.map((productKey) => ({
    productKey,
    connected: linkedByProduct.has(productKey),
    linkedAt: linkedByProduct.get(productKey) ?? null,
  }));

  return finish(200, "success", {
    ok: true,
    wegnAccountId: account.id,
    email: account.email,
    status: account.status,
    createdAt: account.created_at,
    connectedProducts,
    identity: { reachable: true },
  }, { wegnAccountId: account.id });
});
